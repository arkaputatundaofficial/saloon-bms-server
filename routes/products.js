const express = require("express");
const router = express.Router();
const multer = require("multer");
const Papa = require("papaparse");
const xlsx = require("xlsx");
const { authenticate, requireRole } = require("../middleware/auth");

const upload = multer({ storage: multer.memoryStorage() });

// Apply authentication middleware to all routes in this file
router.use(authenticate);

// Helper to update categories table and remove empty ones
async function updateProductCategoryRelation(supabase, productId, newCategoryName) {
    const { data: existingCats } = await supabase
        .from("categories")
        .select("*");

    if (existingCats) {
        for (const cat of existingCats) {
            if (cat.product_ids && cat.product_ids.includes(productId)) {
                if (newCategoryName && cat.name.toLowerCase() === newCategoryName.toLowerCase()) {
                    newCategoryName = null; // Already correctly linked
                } else {
                    const updatedIds = cat.product_ids.filter(id => id !== productId);
                    if (updatedIds.length === 0) {
                        await supabase.from("categories").delete().eq("id", cat.id);
                    } else {
                        await supabase.from("categories").update({ product_ids: updatedIds }).eq("id", cat.id);
                    }
                }
            }
        }
    }

    if (newCategoryName) {
        const { data: targetCat } = await supabase
            .from("categories")
            .select("*")
            .ilike("name", newCategoryName)
            .maybeSingle();

        if (targetCat) {
            const updatedIds = [...(targetCat.product_ids || [])];
            if (!updatedIds.includes(productId)) {
                updatedIds.push(productId);
                await supabase.from("categories").update({ product_ids: updatedIds }).eq("id", targetCat.id);
            }
        } else {
            await supabase.from("categories").insert([{
                name: newCategoryName,
                product_ids: [productId]
            }]);
        }
    }
}

// GET /api/catalogue/products
router.get("/", async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = 8;
        const search = req.query.search || '';
        
        const start = (page - 1) * pageSize;
        const end = start + pageSize - 1;

        let query = req.supabase
            .from("products")
            .select("*");
            
        if (req.query.for_sale !== undefined) {
            query = query.eq('for_sale', req.query.for_sale === 'true');
        }
            
        const { data, error } = await query.order('id', { ascending: false });

        if (error) {
            console.error("Products GET error:", error);
            throw error;
        }

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

        let filteredData = data || [];
        filteredData.forEach(item => {
            item.category = productCategoryMap[item.id] || null;
        });

        if (search) {
            const s = search.toLowerCase();
            filteredData = filteredData.filter(item => {
                return (item.name && String(item.name).toLowerCase().includes(s)) ||
                       (item.sku && String(item.sku).toLowerCase().includes(s)) ||
                       (item.barcode && String(item.barcode).toLowerCase().includes(s)) ||
                       (item.stock_count && String(item.stock_count).toLowerCase().includes(s)) ||
                       (item.price && String(item.price).toLowerCase().includes(s)) ||
                       (item.category && String(item.category).toLowerCase().includes(s));
            });
        }

        const count = filteredData.length;
        const totalPages = Math.ceil(count / pageSize);
        const paginatedData = filteredData.slice(start, end + 1);

        if (req.query.all === 'true') {
            return res.status(200).json({
                data: filteredData,
                pagination: {
                    page: 1,
                    pageSize: filteredData.length,
                    totalItems: filteredData.length,
                    totalPages: 1
                }
            });
        }

        res.status(200).json({
            data: paginatedData,
            pagination: {
                page,
                pageSize,
                totalItems: count,
                totalPages
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/catalogue/products/categories
router.get("/categories", async (req, res) => {
    try {
        const { data, error } = await req.supabase
            .from("categories")
            .select("name")
            .order("name", { ascending: true });

        if (error) throw error;
        res.status(200).json(data.map(c => c.name));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/catalogue/products
router.post("/", requireRole('admin'), async (req, res) => {
    try {
        const insertData = { ...req.body };
        const category = insertData.category;
        delete insertData.category;
        delete insertData.id;
        delete insertData.created_at;

        const { data, error } = await req.supabase
            .from("products")
            .insert([insertData])
            .select()
            .single();

        if (error) throw error;

        if (category) {
            await updateProductCategoryRelation(req.supabase, data.id, category);
            data.category = category;
        } else {
            data.category = null;
        }

        res.status(201).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/catalogue/products/:id
router.put("/:id", requireRole('admin', 'employee'), async (req, res) => {
    try {
        let updateData = { ...req.body };
        const category = updateData.category;
        delete updateData.category;
        delete updateData.id;
        delete updateData.created_at;

        if (req.role === 'employee') {
            const stock_count = updateData.stock_count;
            updateData = {};
            if (stock_count !== undefined) {
                updateData.stock_count = stock_count;
            }
        }

        let updatedProduct = null;
        if (Object.keys(updateData).length > 0) {
            const { data, error } = await req.supabase
                .from("products")
                .update(updateData)
                .eq("id", req.params.id)
                .select()
                .single();

            if (error) throw error;
            updatedProduct = data;
        } else {
            const { data, error } = await req.supabase
                .from("products")
                .select("*")
                .eq("id", req.params.id)
                .single();
            if (error) throw error;
            updatedProduct = data;
        }

        if (req.role === 'admin' && category !== undefined) {
            await updateProductCategoryRelation(req.supabase, updatedProduct.id, category);
            updatedProduct.category = category;
        } else {
            const { data: currentCat } = await req.supabase
                .from("categories")
                .select("name")
                .contains("product_ids", [updatedProduct.id])
                .maybeSingle();
            updatedProduct.category = currentCat ? currentCat.name : null;
        }

        res.status(200).json(updatedProduct);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/catalogue/products (Bulk delete)
router.delete("/", requireRole('admin'), async (req, res) => {
    try {
        // Delete all service_products because they reference products
        await req.supabase.from("service_products").delete().neq("service_id", 0);
        
        const { error } = await req.supabase
            .from("products")
            .delete()
            .neq("id", 0);

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/catalogue/products/:id
router.delete("/:id", requireRole('admin'), async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        
        await updateProductCategoryRelation(req.supabase, productId, null);

        const { error } = await req.supabase
            .from("products")
            .delete()
            .eq("id", productId);

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/catalogue/products/:id/stock
// Admin + Employee, calls the update_stock_count RPC only
router.patch("/:id/stock", requireRole('admin', 'employee'), async (req, res) => {
    try {
        const { stock_count } = req.body;
        if (stock_count === undefined) {
            return res.status(400).json({ error: "stock_count is required" });
        }

        const { error } = await req.supabase
            .from('products')
            .update({ stock_count: parseInt(stock_count) })
            .eq('id', parseInt(req.params.id));

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/catalogue/products/bulk-import
router.post("/bulk-import", requireRole('admin'), upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file provided" });
        }

        let parsedData = [];

        if (req.file.mimetype === 'text/csv' || req.file.originalname.endsWith('.csv')) {
            const csvString = req.file.buffer.toString('utf-8');
            const result = Papa.parse(csvString, { header: true, skipEmptyLines: true });
            parsedData = result.data;
        } else if (req.file.originalname.endsWith('.xlsx') || req.file.originalname.endsWith('.xls')) {
            const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            parsedData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        } else {
            return res.status(400).json({ error: "Invalid file type. Only CSV or XLSX allowed." });
        }

        const report = [];
        
        for (const [index, row] of parsedData.entries()) {
            const { name, price, sku, stock_count, barcode } = row;
            
            if (!name || !price || !sku) {
                report.push({ row: index + 2, success: false, error: "Missing required fields (name, price, sku)" });
                continue;
            }

            const { error } = await req.supabase
                .from("products")
                .insert([{
                    name,
                    price: parseFloat(price),
                    sku,
                    stock_count: stock_count ? parseInt(stock_count) : 0,
                    barcode: barcode ? parseInt(barcode) : null
                }]);

            if (error) {
                report.push({ row: index + 2, success: false, error: error.message });
            } else {
                report.push({ row: index + 2, success: true });
            }
        }

        res.status(200).json({ report });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/catalogue/products/parse-file
router.post("/parse-file", requireRole('admin'), upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file provided" });
        }

        let parsedData = [];
        let linksData = [];

        if (req.file.mimetype === 'text/csv' || req.file.originalname.endsWith('.csv')) {
            const csvString = req.file.buffer.toString('utf-8');
            const result = Papa.parse(csvString, { header: true, skipEmptyLines: true });
            parsedData = result.data;
        } else if (req.file.originalname.endsWith('.xlsx') || req.file.originalname.endsWith('.xls')) {
            const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            parsedData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

            // Check for service products links worksheet (case-insensitive)
            const linkSheetName = workbook.SheetNames.find(name => {
                const lower = name.toLowerCase();
                return lower.includes("link") || lower.includes("service product") || lower.includes("service_product");
            });
            if (linkSheetName) {
                linksData = xlsx.utils.sheet_to_json(workbook.Sheets[linkSheetName]);
            }
        } else {
            return res.status(400).json({ error: "Invalid file type. Only CSV or XLSX allowed." });
        }

        // Helper to normalize objects
        const normalizeKeys = (arr) => {
            return arr.map(item => {
                const keys = Object.keys(item);
                const newItem = {};
                for (const key of keys) {
                    const normKey = key.trim().toLowerCase();
                    let val = item[key];
                    if (typeof val === 'string') val = val.trim();
                    newItem[normKey] = val;
                }
                return newItem;
            });
        };

        const formattedItems = normalizeKeys(parsedData);
        const formattedLinks = normalizeKeys(linksData);

        res.status(200).json({ items: formattedItems, links: formattedLinks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;