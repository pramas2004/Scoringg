const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname, { index: 'home.html' }));

const DATA_DIR = path.join(__dirname, 'tournament_data');
if (!fs.existsSync(DATA_DIR)) { fs.mkdirSync(DATA_DIR); }

const USERS_FILE = 'users.json';
// डिफॉल्ट ब्लँक डेटा (फक्त नवीन युजरसाठी)
const DEFAULT_MATCH_DATA = {
    tournamentInfo: { name: "Pro Cricket 2025", type: "Knockout", limit: "11", groups: "1", start: "", end: "", state: "Live", logo: "" },
    allTeams: [], matchesHistory: [],
    currentMatch: { id: Date.now(), team1: "Team A", team2: "Team B", runs: 0, wickets: 0, balls: 0, overs: "0.0", maxOvers: 5, target: null, inning: 1, isLive: false, striker: { name: "", runs: 0, balls: 0, fours: 0, sixes: 0 }, nonStriker: { name: "", runs: 0, balls: 0, fours: 0, sixes: 0 }, bowler: { name: "", runs: 0, wickets: 0, overs: "0.0", balls: 0 }, thisOver: [], squad1: [], squad2: [], outPlayers: [], bowlingScorecard: {}, overHistory: [0] }
};

let users = [];
let activeTournaments = {}; 

if (fs.existsSync(USERS_FILE)) { try { users = JSON.parse(fs.readFileSync(USERS_FILE)); } catch (e) { console.log(e); } }

function saveUserMatchData(username) {
    if (activeTournaments[username]) {
        fs.writeFile(path.join(DATA_DIR, `match_data_${username}.json`), JSON.stringify(activeTournaments[username], null, 2), (err) => { if (err) console.error(err); });
    }
}

function loadUserMatchData(username) {
    if (activeTournaments[username]) return activeTournaments[username];
    const filePath = path.join(DATA_DIR, `match_data_${username}.json`);
    if (fs.existsSync(filePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(filePath));
            activeTournaments[username] = data;
            return data;
        } catch (e) { console.log("Error loading file", e); }
    }
    const newData = JSON.parse(JSON.stringify(DEFAULT_MATCH_DATA));
    activeTournaments[username] = newData;
    return newData;
}

function saveUsers() { fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), (err) => { if (err) console.error(err); }); }

io.on('connection', (socket) => {
    
    // --- LOGIN & REJOIN FIX ---
    socket.on('adminLogin', (creds) => {
        if(creds.id === 'SuperAdmin' && creds.pass === 'Admin@123') socket.emit('adminLoginSuccess', users);
        else socket.emit('loginFailed', 'Invalid Admin Credentials');
    });

    socket.on('hostLogin', (creds) => {
        let user = users.find(u => u.username === creds.id && u.password === creds.pass);
        if (user) {
            socket.join(user.username);
            socket.username = user.username;
            let userData = loadUserMatchData(user.username);
            
            // First time setup
            if(userData.tournamentInfo.name === "Pro Cricket 2025" && user.tournamentName) {
                userData.tournamentInfo.name = user.tournamentName;
                saveUserMatchData(user.username);
            }
            socket.emit('hostLoginSuccess', userData);
        } else {
            socket.emit('loginFailed', 'Invalid ID or Password');
        }
    });

    // IMPORTANT: Rejoin logic loads YOUR specific file
    socket.on('rejoinGame', (username) => {
        let user = users.find(u => u.username === username);
        if(user) {
            socket.join(username);
            socket.username = username;
            let userData = loadUserMatchData(username); // Load saved data
            socket.emit('updateData', userData); // Send saved data to client
        } else {
            socket.emit('forceLogout'); // Invalid user
        }
    });

    // --- DATA UPDATES ---
    const getMyData = () => (socket.username ? activeTournaments[socket.username] : null);
    const saveMyData = () => {
        if(socket.username) {
            saveUserMatchData(socket.username);
            io.to(socket.username).emit('updateData', activeTournaments[socket.username]);
        }
    };

    // (बाकीचे सर्व इव्हेंट्स जसेच्या तसे)
    socket.on('createUser', (newUser) => {
        if(users.find(u => u.username === newUser.username)) { socket.emit('userActionError', 'Username exists!'); return; }
        users.push(newUser); saveUsers(); 
        activeTournaments[newUser.username] = JSON.parse(JSON.stringify(DEFAULT_MATCH_DATA));
        activeTournaments[newUser.username].tournamentInfo.name = newUser.tournamentName;
        saveUserMatchData(newUser.username);
        socket.emit('refreshUserList', users);
    });

    socket.on('deleteUser', (username) => {
        users = users.filter(u => u.username !== username); saveUsers();
        const filePath = path.join(DATA_DIR, `match_data_${username}.json`);
        if(fs.existsSync(filePath)) fs.unlinkSync(filePath);
        delete activeTournaments[username];
        socket.emit('refreshUserList', users);
    });

    socket.on('updateTournamentInfo', (info) => { let d=getMyData(); if(d){ d.tournamentInfo=info; saveMyData(); }});
    socket.on('addTeamPool', (team) => { let d=getMyData(); if(d){ d.allTeams.push(team); saveMyData(); }});
    
    socket.on('updateTeam', (data) => { 
        let d=getMyData(); if(d && d.allTeams[data.index]) { 
            let oldName = d.allTeams[data.index].name; d.allTeams[data.index] = data.team;
            if(d.currentMatch.isLive) {
                if(d.currentMatch.team1 === oldName) { d.currentMatch.team1 = data.team.name; d.currentMatch.squad1 = data.team.players; }
                if(d.currentMatch.team2 === oldName) { d.currentMatch.team2 = data.team.name; d.currentMatch.squad2 = data.team.players; }
            }
            saveMyData(); 
        } 
    });

    socket.on('deleteTeam', (index) => { let d=getMyData(); if(d){ d.allTeams.splice(index, 1); saveMyData(); }});

    socket.on('startMatch', (m) => {
        let d=getMyData(); if(d) {
            if(d.currentMatch.isLive) d.matchesHistory.push(JSON.parse(JSON.stringify(d.currentMatch)));
            d.tournamentName = m.tournamentName;
            d.currentMatch = { id: Date.now(), team1: m.team1Name, team2: m.team2Name, runs: 0, wickets: 0, balls: 0, overs: "0.0", maxOvers: parseInt(m.overs), target: null, inning: 1, isLive: true, striker: { name: "", runs: 0, balls: 0, fours: 0, sixes: 0 }, nonStriker: { name: "", runs: 0, balls: 0, fours: 0, sixes: 0 }, bowler: { name: "", runs: 0, wickets: 0, overs: "0.0", balls: 0 }, thisOver: [], squad1: m.squad1, squad2: m.squad2, outPlayers: [], bowlingScorecard: {}, overHistory: [0] };
            saveMyData();
        }
    });

    socket.on('endMatch', () => { let d=getMyData(); if(d){ d.currentMatch.isLive=false; d.matchesHistory.push(JSON.parse(JSON.stringify(d.currentMatch))); saveMyData(); }});
    socket.on('scoreUpdate', (m) => { let d=getMyData(); if(d){ if(!m.overHistory) m.overHistory=[0]; d.currentMatch=m; saveMyData(); }});
    socket.on('undoLastAction', () => {}); 
    
    socket.on('changeInnings', () => {
        let d=getMyData(); if(d){
            let cm=d.currentMatch; let target=cm.runs+1; let tN=cm.team1; cm.team1=cm.team2; cm.team2=tN; let tS=cm.squad1; cm.squad1=cm.squad2; cm.squad2=tS;
            cm.runs=0; cm.wickets=0; cm.balls=0; cm.overs="0.0"; cm.thisOver=[]; cm.target=target; cm.inning=2;
            cm.striker={name:"",runs:0,balls:0,fours:0,sixes:0}; cm.nonStriker={name:"",runs:0,balls:0,fours:0,sixes:0}; cm.bowler={name:"",runs:0,wickets:0,overs:"0.0",balls:0}; cm.outPlayers=[]; cm.bowlingScorecard={}; cm.overHistory=[0];
            saveMyData();
        }
    });

    socket.on('resetInningScore', () => {
        let d=getMyData(); if(d){
            let cm=d.currentMatch; cm.runs=0; cm.wickets=0; cm.balls=0; cm.overs="0.0"; cm.thisOver=[];
            cm.striker={name:"",runs:0,balls:0,fours:0,sixes:0}; cm.nonStriker={name:"",runs:0,balls:0,fours:0,sixes:0}; cm.bowler={name:"",runs:0,wickets:0,overs:"0.0",balls:0}; cm.outPlayers=[]; cm.bowlingScorecard={}; cm.overHistory=[0];
            saveMyData();
        }
    });

    socket.on('updatePlayers', (p) => {
        let d=getMyData(); if(d){
            let cm=d.currentMatch;
            if(p.striker) cm.striker={name:p.striker,runs:0,balls:0,fours:0,sixes:0};
            if(p.nonStriker) cm.nonStriker={name:p.nonStriker,runs:0,balls:0,fours:0,sixes:0};
            if(p.bowler) { cm.bowler.name=p.bowler; if(!cm.bowlingScorecard[p.bowler]) cm.bowlingScorecard[p.bowler]={runs:0,wickets:0,balls:0,overs:"0.0"}; let s=cm.bowlingScorecard[p.bowler]; cm.bowler.runs=s.runs; cm.bowler.wickets=s.wickets; cm.bowler.balls=s.balls; cm.bowler.overs=s.overs; }
            if(p.resetThisOver) cm.thisOver=[];
            saveMyData();
        }
    });

    socket.on('updateSquads', (data) => {
        let d=getMyData(); if(d){
            d.currentMatch.squad1=data.squad1; d.currentMatch.squad2=data.squad2;
            let t1=d.allTeams.find(t=>t.name===d.currentMatch.team1); if(t1) t1.players=data.squad1;
            let t2=d.allTeams.find(t=>t.name===d.currentMatch.team2); if(t2) t2.players=data.squad2;
            saveMyData();
        }
    });
});

http.listen(3000, () => { console.log('Server running on 3000'); });