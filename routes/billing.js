const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const { authenticate, requireRole } = require("../middleware/auth");
const xlsx = require("xlsx");

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
        const stockDeductions = {};
        
        for (const item of items) {
            if (item.item_type === 'product') {
                const { data: prod, error } = await req.supabase.from("products").select("*").eq("id", item.item_id).single();
                if (error || !prod) return res.status(400).json({ error: `Product ID ${item.item_id} not found` });
                
                if (!stockDeductions[prod.id]) {
                    stockDeductions[prod.id] = { current_stock: prod.stock_count, deduct_qty: 0, name: prod.name };
                }
                stockDeductions[prod.id].deduct_qty += item.qty;
                
                if (stockDeductions[prod.id].current_stock < stockDeductions[prod.id].deduct_qty) {
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
                    line_total: lineTotal
                });
                
            } else if (item.item_type === 'service') {
                const { data: serv, error } = await req.supabase.from("services").select('*, service_products(quantity, products(*))').eq("id", item.item_id).single();
                if (error || !serv) return res.status(400).json({ error: `Service ID ${item.item_id} not found` });
                
                if (serv.service_products) {
                    for (const sp of serv.service_products) {
                        if (sp.products) {
                            const prod = sp.products;
                            if (!stockDeductions[prod.id]) {
                                stockDeductions[prod.id] = { current_stock: prod.stock_count, deduct_qty: 0, name: prod.name };
                            }
                            stockDeductions[prod.id].deduct_qty += sp.quantity * item.qty;
                            if (stockDeductions[prod.id].current_stock < stockDeductions[prod.id].deduct_qty) {
                                return res.status(400).json({ error: `Insufficient stock for ${prod.name} (required for service ${serv.name})` });
                            }
                        }
                    }
                }
                
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
        // 5. Insert Invoice (including all items directly in the table)
        const { data: invoice, error: invoiceError } = await req.supabase
            .from("invoices")
            .insert([{
                customer_id: customer.id,
                employee_id: req.user.id,
                subtotal,
                discount: discountAmount,
                total,
                payment_mode,
                items: resolvedItems
            }])
            .select()
            .single();
            
        if (invoiceError) throw invoiceError;
        
        // 6. Deduct Stock via Update
        for (const prodId of Object.keys(stockDeductions)) {
            const deduct = stockDeductions[prodId];
            if (deduct.deduct_qty > 0) {
                const { error: updateError } = await req.supabase
                    .from('products')
                    .update({ stock_count: deduct.current_stock - deduct.deduct_qty })
                    .eq('id', prodId);
                if (updateError) throw updateError;
            }
        }
        
        // 7. Update Customer Points
        await req.supabase
            .from("customers")
            .update({ loyalty_points: customer.loyalty_points + earnedPoints })
            .eq("id", customer.id);

        res.status(201).json(invoice);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// POST /api/billing/export (Admin only)
router.post("/export", requireRole('admin'), async (req, res) => {
    try {
        const { tables, dateRange, customRange } = req.body;

        if (!tables || !tables.length) {
            return res.status(400).json({ error: "No tables specified for export" });
        }

        // 1. Determine date filtering boundaries
        let startDate = null;
        let endDate = new Date();

        if (dateRange && dateRange !== 'all') {
            if (dateRange === 'last_month') {
                startDate = new Date();
                startDate.setMonth(startDate.getMonth() - 1);
            } else if (dateRange === 'last_3_months') {
                startDate = new Date();
                startDate.setMonth(startDate.getMonth() - 3);
            } else if (dateRange === 'last_6_months') {
                startDate = new Date();
                startDate.setMonth(startDate.getMonth() - 6);
            } else if (dateRange === 'last_year') {
                startDate = new Date();
                startDate.setFullYear(startDate.getFullYear() - 1);
            } else if (dateRange === 'custom' && customRange && customRange.start && customRange.end) {
                startDate = new Date(customRange.start);
                endDate = new Date(customRange.end);
            }
        }

        const wb = xlsx.utils.book_new();

        // Helper to perform query with date range if table is timestamped
        const fetchTableData = async (tableName, hasDate) => {
            let q = req.supabase.from(tableName).select("*");
            if (hasDate && startDate) {
                q = q.gte("created_at", startDate.toISOString()).lte("created_at", endDate.toISOString());
            }
            const { data, error } = await q;
            if (error) throw error;
            return data || [];
        };

        const appendSheetSafe = (wb, data, sheetName) => {
            let ws;
            if (data && data.length > 0) {
                ws = xlsx.utils.json_to_sheet(data);
            } else {
                ws = xlsx.utils.json_to_sheet([{ "System Message": "No records found in this table for the selected range." }]);
            }
            xlsx.utils.book_append_sheet(wb, ws, sheetName);
        };

        // 2. Fetch and append sheets
        if (tables.includes("users")) {
            const data = await fetchTableData("profiles", true);
            appendSheetSafe(wb, data, "Users");
        }
        if (tables.includes("customers")) {
            const data = await fetchTableData("customers", true);
            appendSheetSafe(wb, data, "Customers");
        }
        if (tables.includes("invoices")) {
            const invoices = await fetchTableData("invoices", true);
            const formattedInvoices = invoices.map(inv => {
                const copy = { ...inv };
                if (copy.items && typeof copy.items === 'object') {
                    copy.items = JSON.stringify(copy.items);
                }
                return copy;
            });
            appendSheetSafe(wb, formattedInvoices, "Invoices");
        }
        if (tables.includes("products")) {
            const data = await fetchTableData("products", false);
            
            const { data: allCategories } = await req.supabase
                .from("categories")
                .select("*");
            
            const productCategoryMap = {};
            if (allCategories) {
                allCategories.forEach(cat => {
                    if (cat.product_ids) {
                        cat.product_ids.forEach(pId => {
                            productCategoryMap[pId] = cat.name;
                        });
                    }
                });
            }

            const formattedProducts = (data || []).map(prod => {
                return {
                    ...prod,
                    category: productCategoryMap[prod.id] || null
                };
            });

            appendSheetSafe(wb, formattedProducts, "Products");
        }
        if (tables.includes("services")) {
            const data = await fetchTableData("services", false);
            appendSheetSafe(wb, data, "Services");

            const serviceIds = data.map(s => s.id);
            let serviceProducts = [];
            if (serviceIds.length > 0) {
                const { data: spData, error } = await req.supabase
                    .from("service_products")
                    .select("*")
                    .in("service_id", serviceIds);
                if (error) throw error;
                serviceProducts = spData || [];
            }
            appendSheetSafe(wb, serviceProducts, "Service Products");
        }
        if (tables.includes("loyalty_rules")) {
            const data = await fetchTableData("loyalty_rules", false);
            appendSheetSafe(wb, data, "Loyalty Rules");
        }

        // 3. Write Excel file to buffer and return it
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=export.xlsx");
        res.send(buffer);

    } catch (err) {
        console.error("Export Error:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
