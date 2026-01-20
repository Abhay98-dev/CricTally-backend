require("dotenv").config();
const express = require('express')
const cors = require('cors')
const authRoutes = require('./routes/authRoutes')
const pool = require('./config/db')
const matchRoutes = require('./routes/matchRoutes')

const app = express()
app.use(express.json())

app.get('/',(req,res)=>{
    res.json({message:"CricTally Backend is live ",status:"success"})
})

app.get("/db-test", async (req, res) => {
    try{
        const result = await pool.query("SELECT NOW()");
        res.json({ ok: true, time: result.rows[0] });
    }catch(err){
        console.error(err);
        res.status(500).json({ ok: false, error: "Database connection error" });
    }
});

app.use('/api/auth', authRoutes)
app.use('/api/matches', matchRoutes)


module.exports = app