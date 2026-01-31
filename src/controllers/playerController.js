const pool = require("../config/db");

/**
 * CREATE PLAYER
 * Owner: logged-in user
 */
const createPlayer = async (req, res) => {
  try {
    const userId = req.user.id; // INTEGER from users.id
    const { name, role } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        ok: false,
        message: "Player name is required",
      });
    }

    // Optional: prevent duplicate player names per user
    const existing = await pool.query(
      `SELECT id FROM public.players
       WHERE created_by = $1 AND LOWER(name) = LOWER($2)`,
      [userId, name.trim()]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        ok: false,
        message: "Player with this name already exists",
      });
    }

    const result = await pool.query(
      `INSERT INTO public.players (created_by, name, role)
       VALUES ($1, $2, $3)
       RETURNING id, name, role, created_at`,
      [userId, name.trim(), role || null]
    );

    return res.status(201).json({
      ok: true,
      message: "Player created successfully",
      player: result.rows[0],
    });
  } catch (error) {
    console.error("CREATE PLAYER ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Server error while creating player",
    });
  }
};

/**
 * GET ALL PLAYERS CREATED BY LOGGED-IN USER
 */
const getMyPlayers = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT id, name, role, created_at
       FROM public.players
       WHERE created_by = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    return res.status(200).json({
      ok: true,
      count: result.rows.length,
      players: result.rows,
    });
  } catch (error) {
    console.error("GET PLAYERS ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "Server error while fetching players",
    });
  }
};

module.exports = {
  createPlayer,
  getMyPlayers,
};
