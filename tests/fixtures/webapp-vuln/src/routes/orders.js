const express = require("express");
const { getOrdersForUser } = require("../db");

const router = express.Router();

// GET /orders?userId=123
router.get("/", (req, res) => {
  getOrdersForUser(req.query.userId, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// GET /orders/export: CSV export of the user's data
router.get("/export", (req, res) => {
  res.status(501).send("TODO: implement export");
});

module.exports = router;
