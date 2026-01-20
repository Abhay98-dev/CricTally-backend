const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const { createMatch , startMatch , addBall } = require("../controllers/matchController");

router.post("/create", authMiddleware, createMatch);
router.post("/:matchId/start", authMiddleware, startMatch);
router.post("/:matchId/ball", authMiddleware, addBall);

module.exports = router;
