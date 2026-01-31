const express = require('express')
const router = express.Router()
const authMiddleware = require('../middlewares/authMiddleware')
const { createPlayer , getPlayerById , getMyPlayers , updatePlayer , deletePlayer } = require('../controllers/playerController')

router.post('/create', authMiddleware , createPlayer)
router.get('/my-players',authMiddleware , getMyPlayers)

module.exports = router