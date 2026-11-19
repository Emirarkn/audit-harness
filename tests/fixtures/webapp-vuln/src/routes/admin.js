const express = require("express");
const { getAllUsers } = require("../db");

const router = express.Router();

router.get("/users", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "login required" });
  getAllUsers((err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

module.exports = router;
