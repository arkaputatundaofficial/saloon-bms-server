const express = require("express");
const router = express.Router();
const multer = require("multer");
const Papa = require("papaparse");
const xlsx = require("xlsx");
const { authenticate, requireRole } = require("../middleware/auth");

const upload = multer({ storage: multer.memoryStorage() });

// Apply authentication middleware to all routes in this file
router.use(authenticate);

// GET /api/catalogue/services
router.get("/", async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = 8;
        const search = req.query.search || '';
        
        const start = (page - 1) * pageSize;
        const end = start + pageSize - 1;

        let query = req.supabase
            .from("services")
            .select("*", { count: "exact" });
            
        if (search) {
            query = query.ilike("name", `%${search}%`);
        }
        
        const { data, count, error } = await query
            .order('id', { ascending: false })
            .range(start, end);

        if (error) {
            console.error("Services GET error:", error);
            throw error;
        }

        const totalPages = Math.ceil((count || 0) / pageSize);

        res.status(200).json({
            data: data,
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

// POST /api/catalogue/services
router.post("/", requireRole('admin'), async (req, res) => {
    try {
        const { data, error } = await req.supabase
            .from("services")
            .insert([req.body])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/catalogue/services/:id
router.put("/:id", requireRole('admin'), async (req, res) => {
    try {
        const { data, error } = await req.supabase
            .from("services")
            .update(req.body)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error) throw error;
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/catalogue/services/:id
router.delete("/:id", requireRole('admin'), async (req, res) => {
    try {
        const { error } = await req.supabase
            .from("services")
            .delete()
            .eq("id", req.params.id);

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/catalogue/services/bulk-import
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
            const { name, price, is_active } = row;
            
            if (!name || !price) {
                report.push({ row: index + 2, success: false, error: "Missing required fields (name, price)" });
                continue;
            }

            const { error } = await req.supabase
                .from("services")
                .insert([{
                    name,
                    price: parseFloat(price),
                    is_active: is_active !== undefined ? (is_active === 'true' || is_active === true) : true
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

module.exports = router;
