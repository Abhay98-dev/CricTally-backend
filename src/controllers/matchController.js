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

const addBall = async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = req.user.id;

    const { runs = 0, isWicket = false, extraType = null } = req.body;

    // 1) Check match exists + ownership from Postgres
    const matchResult = await pool.query(
      "SELECT id, created_by, overs, status FROM public.matches WHERE id = $1",
      [matchId]
    );

    if (matchResult.rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Match not found" });
    }

    const match = matchResult.rows[0];

    if (match.created_by !== userId) {
      return res.status(403).json({ ok: false, message: "Not allowed to score this match" });
    }

    if (match.status !== "LIVE") {
      return res.status(400).json({ ok: false, message: "Match is not LIVE" });
    }

    // 2) Get match state from Redis
    const matchStateKey = `match:${matchId}:state`;
    const state = await redis.get(matchStateKey);

    if (!state) {
      return res.status(404).json({
        ok: false,
        message: "Live match state not found in Redis. Start match first.",
      });
    }

    // 3) Calculate if this delivery counts as a legal ball
    const isLegalBall = extraType !== "WD" && extraType !== "NB";

    // 4) Update total runs
    state.score.runs += Number(runs);

    // Extras (WD/NB) are still runs but do not increase ball count
    if (isLegalBall) {
      state.score.balls += 1;
      state.bowler.balls += 1;
      state.striker.balls += 1;
    }

    // 5) Update batsman runs (for wide/no-ball usually batsman run not counted)
    // MVP rule:
    // - For WD: batsman doesn't get runs
    // - For NB: batsman DOES get runs (if runs provided are off bat)
    if (extraType === null || extraType === "NB") {
      state.striker.runs += Number(runs);

      if (runs === 4) state.striker.fours += 1;
      if (runs === 6) state.striker.sixes += 1;
    }

    // 6) Update bowler runs conceded
    // For MVP: bowler always concedes runs sent in payload
    state.bowler.runs += Number(runs);

    // 7) Handle wicket
    if (isWicket) {
      state.score.wickets += 1;
      state.bowler.wickets += 1;

      // For MVP: just mark wicket in over display
      state.currentOver.push("W");
    } else {
      // Ball display in over
      if (extraType === "WD") state.currentOver.push(`${runs}WD`);
      else if (extraType === "NB") state.currentOver.push(`${runs}NB`);
      else state.currentOver.push(String(runs));
    }

    // 8) Strike change logic (only on legal balls normally)
    // Simple rule:
    // - odd runs -> swap strike
    // - even runs -> same strike
    if (isLegalBall && !isWicket) {
      if (Number(runs) % 2 === 1) {
        const temp = state.striker;
        state.striker = state.nonStriker;
        state.nonStriker = temp;
      }
    }

    // 9) Over completion logic (6 legal balls)
    const ballsInOver = state.score.balls % 6;

    if (ballsInOver === 0 && state.score.balls > 0) {
      // Over completed -> swap strike
      const temp = state.striker;
      state.striker = state.nonStriker;
      state.nonStriker = temp;

      // Reset current over display
      state.currentOver = [];
    }

    // 10) Save updated state back to Redis
    await redis.set(matchStateKey, state);

    return res.status(200).json({
      ok: true,
      message: "Ball updated",
      matchState: state,
    });
  } catch (error) {
    console.error("ADD BALL ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Server error while adding ball",
    });
  }
};

module.exports = { createMatch , startMatch , addBall };
