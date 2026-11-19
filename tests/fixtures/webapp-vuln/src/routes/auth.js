const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const fetch = require("node-fetch");
const config = require("../config");
const { createUser, findUserByEmail } = require("../db");

const router = express.Router();

function hashPassword(pw) {
  return crypto.createHash("md5").update(pw).digest("hex");
}

router.post("/signup", (req, res) => {
  console.log("New signup:", JSON.stringify(req.body));
  const user = {
    email: req.body.email,
    fullName: req.body.fullName,
    phone: req.body.phone,
    passwordHash: hashPassword(req.body.password),
    marketingConsent: req.body.marketingConsent ?? true,
  };
  createUser(user, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    fetch(config.analyticsUrl, {
      method: "POST",
      body: JSON.stringify({ event: "signup", token: config.analyticsToken, email: user.email, phone: user.phone }),
    });
    res.json({ ok: true });
  });
});

router.post("/login", (req, res) => {
  findUserByEmail(req.body.email, (err, user) => {
    if (err || !user || user.password_hash !== hashPassword(req.body.password)) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const token = jwt.sign({ id: user.id, role: user.role }, config.jwtSecret);
    res.json({ token });
  });
});

module.exports = router;
