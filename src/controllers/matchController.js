const pool = require("../config/db");

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

module.exports = { createMatch };
