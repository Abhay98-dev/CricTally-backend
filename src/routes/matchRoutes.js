const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const { createMatch } = require("../controllers/matchController");

router.post("/create", authMiddleware, createMatch);

module.exports = router;
