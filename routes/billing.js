const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const { authenticate } = require("../middleware/auth");

router.use(authenticate);

// GET /api/billing/customers/:phone
router.get("/customers/:phone", async (req, res) => {
    try {
        const { data: customer, error } = await req.supabase
            .from("customers")
            .select("*")
            .eq("phone", req.params.phone)
            .single();

        if (error) {
            if (error.code === 'PGRST116') { // Not found
                return res.status(404).json({ error: "Customer not found" });
            }
            throw error;
        }

        // Loyalty Logic: calculate number of invoices in the last 6 months
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        
        const { count, error: invoiceError } = await req.supabase
            .from("invoices")
            .select('*', { count: 'exact', head: true })
            .eq("customer_id", customer.id)
            .gte("created_at", sixMonthsAgo.toISOString());
            
        if (invoiceError) throw invoiceError;
        
        const recent_purchases = count || 0;
        let tierName = 'regular'; // 0-4
        if (recent_purchases >= 15) tierName = 'platinum';
        else if (recent_purchases >= 10) tierName = 'gold';
        else if (recent_purchases >= 5) tierName = 'silver';
        
        const { data: rule, error: ruleError } = await req.supabase
            .from("loyalty_rules")
            .select("discount_percent")
            .eq("tier", tierName)
            .single();
            
        const discount_percent = rule && !ruleError ? rule.discount_percent : 0;

        res.status(200).json({
            ...customer,
            recent_purchases,
            discount_percent,
            tier: tierName
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/billing/customers
router.post("/customers", async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ error: "phone is required" });
        }

        const { data, error } = await req.supabase
            .from("customers")
            .insert([{ phone }])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/billing/invoices
router.post("/invoices", async (req, res) => {
    try {
        const { customer_phone, items, payment_mode } = req.body;
        // items: [{item_type, item_id, qty}]
        if (!customer_phone || !items || !items.length || !payment_mode) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // 1. Get customer
        let { data: customer, error: customerError } = await req.supabase
            .from("customers")
            .select("*")
            .eq("phone", customer_phone)
            .single();

        if (customerError || !customer) {
            // Auto-create customer if not found
            const { data: newCustomer, error: createError } = await req.supabase
                .from("customers")
                .insert([{ phone: customer_phone }])
                .select()
                .single();
                
            if (createError) {
                return res.status(500).json({ error: "Failed to auto-create customer: " + createError.message });
            }
            customer = newCustomer;
        }

        // 2. Resolve item prices and names from server
        let subtotal = 0;
        const resolvedItems = [];
        
        for (const item of items) {
            if (item.item_type === 'product') {
                const { data: prod, error } = await req.supabase.from("products").select("*").eq("id", item.item_id).single();
                if (error || !prod) return res.status(400).json({ error: `Product ID ${item.item_id} not found` });
                
                if (prod.stock_count < item.qty) {
                    return res.status(400).json({ error: `Insufficient stock for ${prod.name}` });
                }
                
                const lineTotal = prod.price * item.qty;
                subtotal += lineTotal;
                
                resolvedItems.push({
                    item_type: 'product',
                    item_id: prod.id,
                    item_name: prod.name,
                    qty: item.qty,
                    unit_price: prod.price,
                    line_total: lineTotal,
                    current_stock: prod.stock_count // needed for deduction
                });
                
            } else if (item.item_type === 'service') {
                const { data: serv, error } = await req.supabase.from("services").select("*").eq("id", item.item_id).single();
                if (error || !serv) return res.status(400).json({ error: `Service ID ${item.item_id} not found` });
                
                const lineTotal = serv.price * item.qty;
                subtotal += lineTotal;
                
                resolvedItems.push({
                    item_type: 'service',
                    item_id: serv.id,
                    item_name: serv.name,
                    qty: item.qty,
                    unit_price: serv.price,
                    line_total: lineTotal
                });
            } else {
                return res.status(400).json({ error: "Invalid item type" });
            }
        }

        // 3. Apply discount based on dynamic tier (last 6 months)
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        
        const { count, error: invoiceCountError } = await req.supabase
            .from("invoices")
            .select('*', { count: 'exact', head: true })
            .eq("customer_id", customer.id)
            .gte("created_at", sixMonthsAgo.toISOString());
            
        const recent_purchases = count || 0;
        let tierName = 'regular'; // 0-4
        if (recent_purchases >= 15) tierName = 'platinum';
        else if (recent_purchases >= 10) tierName = 'gold';
        else if (recent_purchases >= 5) tierName = 'silver';

        const { data: rule, error: ruleError } = await req.supabase
            .from("loyalty_rules")
            .select("discount_percent")
            .eq("tier", tierName)
            .single();
            
        const discountPercent = rule && !ruleError ? rule.discount_percent : 0;
        const discountAmount = (subtotal * discountPercent) / 100;
        const total = subtotal - discountAmount;

        // 4. Calculate new points (1 point per 100 currency units spent)
        const earnedPoints = Math.floor(total / 100);
        
        // --- Database Writes ---
        // 5. Insert Invoice
        const { data: invoice, error: invoiceError } = await req.supabase
            .from("invoices")
            .insert([{
                customer_id: customer.id,
                employee_id: req.user.id,
                subtotal,
                discount: discountAmount,
                total,
                payment_mode
            }])
            .select()
            .single();
            
        if (invoiceError) throw invoiceError;

        // 6. Insert Invoice Items
        const invoiceItemsData = resolvedItems.map(ri => ({
            invoice_id: invoice.id,
            item_type: ri.item_type,
            item_id: ri.item_id,
            item_name: ri.item_name,
            qty: ri.qty,
            unit_price: ri.unit_price,
            line_total: ri.line_total
        }));
        
        const { error: itemsError } = await req.supabase
            .from("invoice_items")
            .insert(invoiceItemsData);
            
        if (itemsError) throw itemsError;
        
        // 7. Deduct Stock via Update
        for (const ri of resolvedItems) {
            if (ri.item_type === 'product') {
                const { error: updateError } = await req.supabase
                    .from('products')
                    .update({ stock_count: ri.current_stock - ri.qty })
                    .eq('id', ri.item_id);
                if (updateError) throw updateError;
            }
        }
        
        // 8. Update Customer Points
        await req.supabase
            .from("customers")
            .update({ loyalty_points: customer.loyalty_points + earnedPoints })
            .eq("id", customer.id);

        res.status(201).json({ ...invoice, items: invoiceItemsData });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/billing/invoices/:id/pdf
router.get("/invoices/:id/pdf", async (req, res) => {
    try {
        const invoiceId = req.params.id;

        const { data: invoice, error } = await req.supabase
            .from("invoices")
            .select(`
                *,
                customers ( phone ),
                invoice_items ( item_name, qty, unit_price, line_total )
            `)
            .eq("id", invoiceId)
            .single();

        if (error || !invoice) {
            return res.status(404).json({ error: "Invoice not found" });
        }

        const doc = new PDFDocument({ margin: 50 });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=invoice_${invoiceId}.pdf`);
        
        doc.pipe(res);
        
        // Header
        doc.fontSize(20).text('Salon BMS Invoice', { align: 'center' });
        doc.moveDown();
        
        // Customer Info
        doc.fontSize(12).text(`Invoice ID: ${invoice.id}`);
        doc.text(`Date: ${new Date(invoice.created_at).toLocaleString()}`);
        doc.text(`Customer: ${invoice.customers.phone}`);
        doc.text(`Payment Mode: ${invoice.payment_mode}`);
        doc.moveDown();
        
        // Items Table Header
        const tableTop = 200;
        doc.font('Helvetica-Bold');
        doc.text('Item', 50, tableTop);
        doc.text('Qty', 300, tableTop);
        doc.text('Unit Price', 380, tableTop);
        doc.text('Total', 480, tableTop);
        
        doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
        
        let y = tableTop + 25;
        doc.font('Helvetica');
        
        // Items
        for (const item of invoice.invoice_items) {
            doc.text(item.item_name, 50, y);
            doc.text(item.qty.toString(), 300, y);
            doc.text(`$${item.unit_price.toFixed(2)}`, 380, y);
            doc.text(`$${item.line_total.toFixed(2)}`, 480, y);
            y += 20;
        }
        
        doc.moveTo(50, y).lineTo(550, y).stroke();
        y += 10;
        
        // Totals
        doc.font('Helvetica-Bold');
        doc.text('Subtotal:', 380, y);
        doc.text(`$${invoice.subtotal.toFixed(2)}`, 480, y);
        y += 20;
        
        doc.text('Discount:', 380, y);
        doc.text(`-$${invoice.discount.toFixed(2)}`, 480, y);
        y += 20;
        
        doc.fontSize(14);
        doc.text('Total:', 380, y);
        doc.text(`$${invoice.total.toFixed(2)}`, 480, y);
        
        doc.end();

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
