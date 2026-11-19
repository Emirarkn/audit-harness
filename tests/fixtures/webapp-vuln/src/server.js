const express = require("express");
const jwt = require("jsonwebtoken");
const config = require("./config");

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.use((req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");
  if (token) {
    try { req.user = jwt.verify(token, config.jwtSecret); } catch (e) { /* ignore */ }
  }
  next();
});

app.use("/auth", require("./routes/auth"));
app.use("/orders", require("./routes/orders"));
app.use("/admin", require("./routes/admin"));

app.listen(config.port, () => console.log(`ShopLite on ${config.port}`));
