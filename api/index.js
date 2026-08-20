require("dotenv").config();

const PORT = process.env.PORT;
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const productsRouter = require("../routes/products");
const servicesRouter = require("../routes/services");
const authRouter = require("../routes/auth");
const billingRouter = require("../routes/billing");
const { router: attendanceRouter, runDailyRolloverInternal } = require("../routes/attendance");
const supabase = require("../supabaseClient");

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", authRouter);
app.use("/api/catalogue/products", productsRouter);
app.use("/api/catalogue/services", servicesRouter);
app.use("/api/billing", billingRouter);
app.use("/api/attendance", attendanceRouter);

// Health check
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Server is running."
    });
});

// Public Invoice Viewer
app.get("/:customerId/:billId", async (req, res) => {
    try {
        const { customerId, billId } = req.params;

        const { data: invoice, error } = await supabase
            .from("invoices")
            .select(`
                *,
                customers ( phone )
            `)
            .eq("id", billId)
            .eq("customer_id", customerId)
            .single();

        if (error || !invoice) {
            return res.status(404).send(`
                <div style="font-family:sans-serif; text-align:center; padding-top:100px; color:#444;">
                    <h2>Invoice Not Found</h2>
                    <p>This invoice does not exist or you do not have permission to view it.</p>
                </div>
            `);
        }

        const itemsHtml = (invoice.items || []).map(item => `
            <tr>
                <td>${item.item_name}</td>
                <td>${item.qty}</td>
                <td>₹${item.unit_price.toFixed(2)}</td>
                <td>₹${item.line_total.toFixed(2)}</td>
            </tr>
        `).join('');

        const templatePath = path.join(__dirname, "../views/invoice.html");
        let html = fs.readFileSync(templatePath, "utf8");

        html = html
            .replace(/{{INVOICE_ID}}/g, invoice.id)
            .replace(/{{DATE}}/g, new Date(invoice.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }))
            .replace(/{{PHONE}}/g, invoice.customers?.phone || "N/A")
            .replace(/{{PAYMENT_MODE}}/g, invoice.payment_mode)
            .replace(/{{ITEMS_HTML}}/g, itemsHtml)
            .replace(/{{SUBTOTAL}}/g, invoice.subtotal.toFixed(2))
            .replace(/{{DISCOUNT}}/g, invoice.discount.toFixed(2))
            .replace(/{{TOTAL}}/g, invoice.total.toFixed(2))
            .replace(/{{INVOICE_JSON}}/g, JSON.stringify(invoice));

        res.send(html);
    } catch (err) {
        console.error("Public Invoice Route Error:", err);
        res.status(500).send("<h1 style='text-align:center; margin-top:50px; font-family:sans-serif;'>Server Error</h1>");
    }
});

// Setup automatic midnight daily rollover (runs in local persistent Node server)
let lastRolloverDateString = new Date().toDateString();

setInterval(async () => {
    const todayDateString = new Date().toDateString();
    if (todayDateString !== lastRolloverDateString) {
        console.log(`[Scheduler] Date changed from ${lastRolloverDateString} to ${todayDateString}. Executing daily rollover...`);
        lastRolloverDateString = todayDateString;
        try {
            await runDailyRolloverInternal();
            console.log("[Scheduler] Daily rollover completed successfully.");
        } catch (err) {
            console.error("[Scheduler] Daily rollover failed:", err);
        }
    }
}, 60000); // Check once a minute

// Run startup catchup check to make sure yesterday's rollover wasn't missed
setTimeout(async () => {
    console.log("[Startup] Checking for missed daily attendance rollovers...");
    try {
        const result = await runDailyRolloverInternal();
        if (result && result.skipped) {
            console.log("[Startup] Missed rollover check: No action required.");
        } else if (result) {
            console.log(`[Startup] Missed rollover check: Rollover caught up for date ${result.date}.`);
        }
    } catch (err) {
        console.error("[Startup] Missed rollover catch-up failed:", err);
    }
}, 5000);

if (process.env.NODE_ENV !== 'production') {
    const port = PORT;
    app.listen(port, "0.0.0.0", () => {
        console.log(`Server running on port ${port}`);
    });
}

module.exports = app;