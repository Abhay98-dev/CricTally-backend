const express = require("express");
const router = express.Router();

const {
  getLiveMatches,
  getUpcomingMatches,
  getCompletedMatches,
} = require("../controllers/publicController");

router.get("/matches/live", getLiveMatches)
router.get("/matches/upcoming", getUpcomingMatches)
router.get("/matches/completed", getCompletedMatches)

module.exports = router;