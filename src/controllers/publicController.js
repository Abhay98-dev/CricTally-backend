const pool = require("../config/db");

// ✅ LIVE Matches
const getLiveMatches = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, team_a_name, team_b_name, overs, status, created_at
       FROM public.matches
       WHERE status = 'LIVE'
       ORDER BY created_at DESC`
    );

    return res.status(200).json({
      ok: true,
      matches: result.rows,
    });
  } catch (error) {
    console.error("GET LIVE MATCHES ERROR:", error);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
};

// ✅ UPCOMING Matches (not started yet)
const getUpcomingMatches = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, team_a_name, team_b_name, overs, status, created_at
       FROM public.matches
       WHERE status = 'CREATED'
       ORDER BY created_at DESC`
    );

    return res.status(200).json({
      ok: true,
      matches: result.rows,
    });
  } catch (error) {
    console.error("GET UPCOMING MATCHES ERROR:", error);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
};

// ✅ COMPLETED Matches
const getCompletedMatches = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, team_a_name, team_b_name, overs, status, winner, result_text, created_at
       FROM public.matches
       WHERE status = 'COMPLETED'
       ORDER BY created_at DESC`
    );

    return res.status(200).json({
      ok: true,
      matches: result.rows,
    });
  } catch (error) {
    console.error("GET COMPLETED MATCHES ERROR:", error);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
};

module.exports = { getLiveMatches, getUpcomingMatches, getCompletedMatches };
