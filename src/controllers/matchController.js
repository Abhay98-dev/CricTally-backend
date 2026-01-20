const pool = require("../config/db");
const redis = require("../config/redis");


const createMatch = async (req, res) => {
  try {
    const { teamAName, teamBName, overs } = req.body;
    const userId = req.user.id;

    // Validation
    if (!teamAName || !teamBName || !overs) {
      return res.status(400).json({
        ok: false,
        message: "teamAName, teamBName and overs are required",
      });
    }

    if (Number(overs) <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Overs must be greater than 0",
      });
    }

    // Insert match
    const result = await pool.query(
      `INSERT INTO public.matches (created_by, team_a_name, team_b_name, overs, status)
       VALUES ($1, $2, $3, $4, 'CREATED')
       RETURNING id, created_by, team_a_name, team_b_name, overs, status, created_at`,
      [userId, teamAName, teamBName, overs]
    );

    return res.status(201).json({
      ok: true,
      message: "Match created successfully",
      match: result.rows[0],
    });
  } catch (error) {
    console.error("CREATE MATCH ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Server error while creating match",
    });
  }
};

const startMatch = async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = req.user.id;

    const { tossWinner, tossDecision, openingBatsman1, openingBatsman2, openingBowler } = req.body;

    // 1) validation
    if (!tossWinner || !tossDecision || !openingBatsman1 || !openingBatsman2 || !openingBowler) {
      return res.status(400).json({
        ok: false,
        message: "All start match fields are required",
      });
    }

    // 2) check match exists + ownership
    const matchResult = await pool.query(
      "SELECT * FROM public.matches WHERE id = $1",
      [matchId]
    );

    if (matchResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "Match not found",
      });
    }

    const match = matchResult.rows[0];

    if (match.created_by !== userId) {
      return res.status(403).json({
        ok: false,
        message: "You are not allowed to start this match",
      });
    }

    if (match.status !== "CREATED") {
      return res.status(400).json({
        ok: false,
        message: `Match cannot be started. Current status: ${match.status}`,
      });
    }

    // 3) Update match status to LIVE
    await pool.query(
      "UPDATE public.matches SET status = 'LIVE' WHERE id = $1",
      [matchId]
    );

    // 4) Create Redis state
    const matchStateKey = `match:${matchId}:state`;

    const matchState = {
      matchId: Number(matchId),
      innings: 1,
      status: "LIVE",

      teamA: match.team_a_name,
      teamB: match.team_b_name,
      oversLimit: match.overs,

      tossWinner,
      tossDecision,

      score: {
        runs: 0,
        wickets: 0,
        balls: 0, // total balls in innings
      },

      currentOver: [],

      striker: {
        name: openingBatsman1,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
      },

      nonStriker: {
        name: openingBatsman2,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
      },

      bowler: {
        name: openingBowler,
        balls: 0,
        runs: 0,
        wickets: 0,
      },
    };

    await redis.set(matchStateKey, matchState);

    return res.status(200).json({
      ok: true,
      message: "Match started successfully",
      matchState,
    });
  } catch (error) {
    console.error("START MATCH ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Server error while starting match",
    });
  }
};

module.exports = { createMatch , startMatch };
