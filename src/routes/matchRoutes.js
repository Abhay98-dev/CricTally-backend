const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const { createMatch , startMatch , addBall , deleteMatch , changeBowler , endInnings , startInnings2} = require("../controllers/matchController");

router.post("/create", authMiddleware, createMatch);
router.post("/:matchId/start", authMiddleware, startMatch);
router.post("/:matchId/ball", authMiddleware, addBall);
router.post("/:matchId/change-bowler", authMiddleware, changeBowler);
router.post("/:matchId/end-innings", authMiddleware, endInnings);
router.post("/:matchId/start-innings2", authMiddleware, startInnings2);
router.delete("/:matchId", authMiddleware, deleteMatch);

module.exports = router;
