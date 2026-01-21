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

    const {
      tossWinner,
      tossDecision,
      openingBatsman1,
      openingBatsman2,
      openingBowler,
      teamAPlayers,
      teamBPlayers,
    } = req.body;

    // ✅ Basic validation
    if (
      !tossWinner ||
      !tossDecision ||
      !openingBatsman1 ||
      !openingBatsman2 ||
      !openingBowler
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "tossWinner, tossDecision, openingBatsman1, openingBatsman2, openingBowler are required",
      });
    }

    // ✅ Players list validation
    if (!Array.isArray(teamAPlayers) || !Array.isArray(teamBPlayers)) {
      return res.status(400).json({
        ok: false,
        message: "teamAPlayers and teamBPlayers must be arrays",
      });
    }

    if (teamAPlayers.length < 2 || teamBPlayers.length < 2) {
      return res.status(400).json({
        ok: false,
        message: "Each team must have at least 2 players",
      });
    }

    // 1) check match exists + ownership
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

    // ✅ Validate opening players are in squads
    if (!teamAPlayers.includes(openingBatsman1) && !teamBPlayers.includes(openingBatsman1)) {
      return res.status(400).json({
        ok: false,
        message: "openingBatsman1 must be present in teamAPlayers or teamBPlayers",
      });
    }

    if (!teamAPlayers.includes(openingBatsman2) && !teamBPlayers.includes(openingBatsman2)) {
      return res.status(400).json({
        ok: false,
        message: "openingBatsman2 must be present in teamAPlayers or teamBPlayers",
      });
    }

    if (!teamAPlayers.includes(openingBowler) && !teamBPlayers.includes(openingBowler)) {
      return res.status(400).json({
        ok: false,
        message: "openingBowler must be present in teamAPlayers or teamBPlayers",
      });
    }

    // 2) Store squads in PostgreSQL (match_players)
    // ✅ remove old players if match restarted (safety)
    await pool.query("DELETE FROM public.match_players WHERE match_id = $1", [
      matchId,
    ]);

    // ✅ insert team A players
    for (const player of teamAPlayers) {
      await pool.query(
        "INSERT INTO public.match_players (match_id, team_name, player_name) VALUES ($1, $2, $3)",
        [matchId, match.team_a_name, player]
      );
    }

    // ✅ insert team B players
    for (const player of teamBPlayers) {
      await pool.query(
        "INSERT INTO public.match_players (match_id, team_name, player_name) VALUES ($1, $2, $3)",
        [matchId, match.team_b_name, player]
      );
    }

    // 3) Update match status to LIVE
    await pool.query("UPDATE public.matches SET status = 'LIVE' WHERE id = $1", [
      matchId,
    ]);

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

      // ✅ squads
      players: {
        [match.team_a_name]: teamAPlayers,
        [match.team_b_name]: teamBPlayers,
      },

      // ✅ innings score
      score: {
        runs: 0,
        wickets: 0,
        balls: 0,
      },

      currentOver: [],

      // ✅ current players
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

      // ✅ full stats maps (important)
      battingStats: {},
      bowlingStats: {},
      fallOfWickets: [],
    };

    // ✅ init stats for all players
    const allPlayers = [...teamAPlayers, ...teamBPlayers];

    for (const p of allPlayers) {
      matchState.battingStats[p] = {
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        out: false,
      };

      matchState.bowlingStats[p] = {
        balls: 0,
        runs: 0,
        wickets: 0,
      };
    }

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

const deleteMatch = async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = req.user.id;

    // check match exists + ownership
    const matchResult = await pool.query(
      "SELECT id, created_by FROM public.matches WHERE id = $1",
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
        message: "You are not allowed to delete this match",
      });
    }

    // delete redis match state (if present)
    await redis.del(`match:${matchId}:state`);

    // delete match from postgres (will auto delete match_players because of cascade)
    await pool.query("DELETE FROM public.matches WHERE id = $1", [matchId]);

    return res.status(200).json({
      ok: true,
      message: "Match deleted successfully",
    });
  } catch (error) {
    console.error("DELETE MATCH ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Server error while deleting match",
    });
  }
};


const addBall = async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = req.user.id;

    const {
      runs = 0,
      isWicket = false,
      extraType = null,
      newBatsman = null,
      wicketType = null,
    } = req.body;

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

    const strikerName = state.striker.name;
    const bowlerName = state.bowler.name;

    // 3) Validate stats maps exist
    if (!state.battingStats || !state.bowlingStats) {
      return res.status(500).json({
        ok: false,
        message: "Match stats are missing in Redis state",
      });
    }

    // 4) Determine legal ball
    const isLegalBall = extraType !== "WD" && extraType !== "NB";

    // 5) Update total runs
    state.score.runs += Number(runs);

    // ✅ Update bowler conceded runs
    state.bowler.runs += Number(runs);
    state.bowlingStats[bowlerName].runs += Number(runs);

    // ✅ Ball count updates only for legal balls
    if (isLegalBall) {
      state.score.balls += 1;

      state.bowler.balls += 1;
      state.bowlingStats[bowlerName].balls += 1;

      state.striker.balls += 1;
      state.battingStats[strikerName].balls += 1;
    }

    // ✅ Batsman runs (MVP rules)
    // - WD: no batsman runs
    // - NB: allow batsman runs if provided
    if (extraType === null || extraType === "NB") {
      state.striker.runs += Number(runs);
      state.battingStats[strikerName].runs += Number(runs);

      if (Number(runs) === 4) {
        state.striker.fours += 1;
        state.battingStats[strikerName].fours += 1;
      }

      if (Number(runs) === 6) {
        state.striker.sixes += 1;
        state.battingStats[strikerName].sixes += 1;
      }
    }

    // 6) Add ball to currentOver display
    if (isWicket) {
      state.currentOver.push("W");
    } else {
      if (extraType === "WD") state.currentOver.push(`${runs}WD`);
      else if (extraType === "NB") state.currentOver.push(`${runs}NB`);
      else state.currentOver.push(String(runs));
    }

    // 7) Handle wicket logic (NEW ✅)
    if (isWicket) {
      state.score.wickets += 1;

      state.bowler.wickets += 1;
      state.bowlingStats[bowlerName].wickets += 1;

      // ✅ mark striker out in battingStats
      state.battingStats[strikerName].out = true;

      // ✅ save fall of wicket
      state.fallOfWickets.push({
        wicketNo: state.score.wickets,
        batsman: strikerName,
        scoreAtWicket: state.score.runs,
        balls: state.score.balls,
        wicketType: wicketType || "unknown",
        bowler: bowlerName,
      });

      // ✅ new batsman required (only if innings not ended)
      if (!newBatsman) {
        return res.status(400).json({
          ok: false,
          message: "newBatsman is required when wicket falls",
        });
      }

      // ✅ Validate new batsman exists in squad
      const allPlayers = [
        ...(state.players[state.teamA] || []),
        ...(state.players[state.teamB] || []),
      ];

      if (!allPlayers.includes(newBatsman)) {
        return res.status(400).json({
          ok: false,
          message: "newBatsman must be present in match squads",
        });
      }

      // ✅ New batsman must not already be out
      if (state.battingStats[newBatsman]?.out === true) {
        return res.status(400).json({
          ok: false,
          message: "newBatsman is already out. Choose another player.",
        });
      }

      // ✅ Replace striker with new batsman (fresh object)
      state.striker = {
        name: newBatsman,
        runs: state.battingStats[newBatsman]?.runs || 0,
        balls: state.battingStats[newBatsman]?.balls || 0,
        fours: state.battingStats[newBatsman]?.fours || 0,
        sixes: state.battingStats[newBatsman]?.sixes || 0,
      };
    }

    // 8) Strike rotation (skip if wicket happened)
    if (isLegalBall && !isWicket) {
      if (Number(runs) % 2 === 1) {
        const temp = state.striker;
        state.striker = state.nonStriker;
        state.nonStriker = temp;
      }
    }

    // 9) Over complete swap strike + reset currentOver
    const ballsInOver = state.score.balls % 6;

    if (ballsInOver === 0 && state.score.balls > 0) {
      const temp = state.striker;
      state.striker = state.nonStriker;
      state.nonStriker = temp;

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

const changeBowler = async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = req.user.id;

    const { newBowler } = req.body;

    if (!newBowler) {
      return res.status(400).json({
        ok: false,
        message: "newBowler is required",
      });
    }

    // ✅ Check match exists + ownership
    const matchResult = await pool.query(
      "SELECT id, created_by, status FROM public.matches WHERE id = $1",
      [matchId]
    );

    if (matchResult.rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Match not found" });
    }

    const match = matchResult.rows[0];

    if (match.created_by !== userId) {
      return res.status(403).json({ ok: false, message: "Not allowed" });
    }

    if (match.status !== "LIVE") {
      return res.status(400).json({ ok: false, message: "Match is not LIVE" });
    }

    // ✅ Get match state from Redis
    const matchStateKey = `match:${matchId}:state`;
    const state = await redis.get(matchStateKey);

    if (!state) {
      return res.status(404).json({
        ok: false,
        message: "Live match state not found in Redis",
      });
    }

    // ✅ Validate new bowler exists in squad
    const allPlayers = [
      ...(state.players[state.teamA] || []),
      ...(state.players[state.teamB] || []),
    ];

    if (!allPlayers.includes(newBowler)) {
      return res.status(400).json({
        ok: false,
        message: "newBowler must be present in match squads",
      });
    }

    // ✅ Prevent same bowler continuing (optional)
    if (state.bowler.name === newBowler) {
      return res.status(400).json({
        ok: false,
        message: "Same bowler cannot bowl consecutive overs",
      });
    }

    // ✅ Set new bowler (stats already exist in bowlingStats map)
    state.bowler = {
      name: newBowler,
      balls: state.bowlingStats[newBowler]?.balls || 0,
      runs: state.bowlingStats[newBowler]?.runs || 0,
      wickets: state.bowlingStats[newBowler]?.wickets || 0,
    };

    await redis.set(matchStateKey, state);

    return res.status(200).json({
      ok: true,
      message: "Bowler changed successfully",
      matchState: state,
    });
  } catch (error) {
    console.error("CHANGE BOWLER ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Server error while changing bowler",
    });
  }
};

const endInnings = async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = req.user.id;

    // ✅ check match exists + ownership
    const matchResult = await pool.query(
      "SELECT id, created_by, status, overs, team_a_name, team_b_name FROM public.matches WHERE id = $1",
      [matchId]
    );

    if (matchResult.rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Match not found" });
    }

    const match = matchResult.rows[0];

    if (match.created_by !== userId) {
      return res.status(403).json({ ok: false, message: "Not allowed" });
    }

    if (match.status !== "LIVE") {
      return res.status(400).json({ ok: false, message: "Match is not LIVE" });
    }

    // ✅ get state from redis
    const matchStateKey = `match:${matchId}:state`;
    const state = await redis.get(matchStateKey);

    if (!state) {
      return res.status(404).json({
        ok: false,
        message: "Live match state not found in Redis",
      });
    }

    const maxBalls = Number(state.oversLimit) * 6;

    const inningsShouldEnd =
      state.score.wickets >= 10 || state.score.balls >= maxBalls;

    // ✅ Optional: allow manual innings end
    // If you want to force end innings even if not completed:
    const forceEnd = req.body?.forceEnd === true;


    if (!inningsShouldEnd && !forceEnd) {
      return res.status(400).json({
        ok: false,
        message: "Innings is not complete yet (overs/wickets remaining). Use forceEnd=true to end manually.",
      });
    }

    // ✅ compute oversPlayed
    const oversPlayed = `${Math.floor(state.score.balls / 6)}.${state.score.balls % 6}`;

    // ✅ Decide batting team (simple for now)
    // If tossDecision = BAT then tossWinner bats first
    // Else opponent bats first
    let battingTeam = "";

    if (state.tossDecision === "BAT") {
      battingTeam = state.tossWinner;
    } else {
      battingTeam =
        state.tossWinner === state.teamA ? state.teamB : state.teamA;
    }

    // ✅ Save innings to PostgreSQL
    const inningsData = {
      striker: state.striker,
      nonStriker: state.nonStriker,
      bowler: state.bowler,
      battingStats: state.battingStats,
      bowlingStats: state.bowlingStats,
      fallOfWickets: state.fallOfWickets,
    };

    await pool.query(
      `INSERT INTO public.innings
       (match_id, innings_no, batting_team, total_runs, wickets, balls, overs_played, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        matchId,
        state.innings,
        battingTeam,
        state.score.runs,
        state.score.wickets,
        state.score.balls,
        oversPlayed,
        inningsData,
      ]
    );

    // ✅ If innings 1 ends → prepare innings 2 in Redis
    if (state.innings === 1) {
      state.innings = 2;

      // target = runs+1
      state.target = state.score.runs + 1;

      // reset score for innings 2
      state.score = { runs: 0, wickets: 0, balls: 0 };
      state.currentOver = [];
      state.fallOfWickets = [];

      // NOTE: striker/nonStriker/bowler should be set again by frontend
      // We'll keep them as null for now
      state.striker = null;
      state.nonStriker = null;
      state.bowler = null;

      // reset battingStats for innings 2? (optional)
      // Better: keep stats, but for MVP we can keep same maps
      // OR create new maps: battingStats2 / bowlingStats2 (advanced)

      await redis.set(matchStateKey, state);

      return res.status(200).json({
        ok: true,
        message: "Innings 1 ended. Innings 2 is ready to start.",
        target: state.target,
        matchState: state,
      });
    }

    // ✅ If innings 2 ends → match completed
    if (state.innings === 2) {
      await pool.query(
        "UPDATE public.matches SET status = 'COMPLETED' WHERE id = $1",
        [matchId]
      );

      // cleanup redis
      await redis.del(matchStateKey);

      return res.status(200).json({
        ok: true,
        message: "Match completed successfully",
      });
    }
  } catch (error) {
    console.error("END INNINGS ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Server error while ending innings",
    });
  }
};

const startInnings2 = async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = req.user.id;

    const { openingBatsman1, openingBatsman2, openingBowler } = req.body;

    if (!openingBatsman1 || !openingBatsman2 || !openingBowler) {
      return res.status(400).json({
        ok: false,
        message: "openingBatsman1, openingBatsman2 and openingBowler are required",
      });
    }

    // ✅ check match exists + ownership
    const matchResult = await pool.query(
      "SELECT id, created_by, status FROM public.matches WHERE id = $1",
      [matchId]
    );

    if (matchResult.rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Match not found" });
    }

    const match = matchResult.rows[0];

    if (match.created_by !== userId) {
      return res.status(403).json({ ok: false, message: "Not allowed" });
    }

    if (match.status !== "LIVE") {
      return res.status(400).json({ ok: false, message: "Match is not LIVE" });
    }

    // ✅ get redis state
    const matchStateKey = `match:${matchId}:state`;
    const state = await redis.get(matchStateKey);

    if (!state) {
      return res.status(404).json({
        ok: false,
        message: "Live match state not found in Redis",
      });
    }

    if (state.innings !== 2) {
      return res.status(400).json({
        ok: false,
        message: "You can start innings 2 only when innings=2",
      });
    }

    // ✅ validate players are in squads
    const allPlayers = [
      ...(state.players[state.teamA] || []),
      ...(state.players[state.teamB] || []),
    ];

    if (!allPlayers.includes(openingBatsman1) || !allPlayers.includes(openingBatsman2)) {
      return res.status(400).json({
        ok: false,
        message: "Opening batsmen must be in match squads",
      });
    }

    if (!allPlayers.includes(openingBowler)) {
      return res.status(400).json({
        ok: false,
        message: "Opening bowler must be in match squads",
      });
    }

    // ✅ set striker/non-striker/bowler
    state.striker = {
      name: openingBatsman1,
      runs: state.battingStats[openingBatsman1]?.runs || 0,
      balls: state.battingStats[openingBatsman1]?.balls || 0,
      fours: state.battingStats[openingBatsman1]?.fours || 0,
      sixes: state.battingStats[openingBatsman1]?.sixes || 0,
    };

    state.nonStriker = {
      name: openingBatsman2,
      runs: state.battingStats[openingBatsman2]?.runs || 0,
      balls: state.battingStats[openingBatsman2]?.balls || 0,
      fours: state.battingStats[openingBatsman2]?.fours || 0,
      sixes: state.battingStats[openingBatsman2]?.sixes || 0,
    };

    state.bowler = {
      name: openingBowler,
      balls: state.bowlingStats[openingBowler]?.balls || 0,
      runs: state.bowlingStats[openingBowler]?.runs || 0,
      wickets: state.bowlingStats[openingBowler]?.wickets || 0,
    };

    state.currentOver = [];

    await redis.set(matchStateKey, state);

    return res.status(200).json({
      ok: true,
      message: "Innings 2 started successfully",
      matchState: state,
    });
  } catch (error) {
    console.error("START INNINGS 2 ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Server error while starting innings 2",
    });
  }
};


module.exports = { createMatch , startMatch , addBall , deleteMatch , changeBowler , endInnings , startInnings2 };
