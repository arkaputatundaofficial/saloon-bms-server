require("dotenv").config();

const PORT = process.env.PORT;
const express = require("express");
const cors = require("cors");

const productsRouter = require("../routes/products");
const servicesRouter = require("../routes/services");
const authRouter = require("../routes/auth");
const billingRouter = require("../routes/billing");

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", authRouter);
app.use("/api/catalogue/products", productsRouter);
app.use("/api/catalogue/services", servicesRouter);
app.use("/api/billing", billingRouter);

// Health check
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Server is running."
    });
});

if (process.env.NODE_ENV !== 'production') {
    const port = PORT;
    app.listen(port, "0.0.0.0", () => {
        console.log(`Server running on port ${port}`);
    });
}

module.exports = app;