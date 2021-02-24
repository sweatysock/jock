// Voicevault server
// 
// Mark Gemmell Feb 2021
//

const SampleRate = 32000; 						// All audio runs at this sample rate regardless of the client hardware
const PacketSize = 1000;						// Number of samples in the client audio packets
var zipson = require('zipson');						// For compressing and decompressing data

// Network code
//
// Set up network stack and listen on ports as required
var fs = require('fs');							// File access
var express = require('express');				
var app = express();
app.use(express.static('public'));
var PORT = process.env.PORT; 
if (PORT == undefined) {						// Not running on heroku so use SSL
	var https = require('https');
	var SSLPORT = 443; 
	var HTTPPORT = 80; 						// Only used for redirect to https
	var privateKeyPath = "./cert/key.pem"; 				// Temporary keys
	var certificatePath = "./cert/cert.pem"; 
	var privateKey = fs.readFileSync( privateKeyPath );
	var certificate = fs.readFileSync( certificatePath );
	var server = https.createServer({
    		key: privateKey,
    		cert: certificate
	}, app).listen(SSLPORT);
	var http = require('http');					// Redirect from http to https
	http.createServer(function (req, res) {
    		res.writeHead(301, { "Location": "https://" + req.headers['host'] + ":"+ SSLPORT + "" + req.url });
    		res.end();
	}).listen(HTTPPORT);
} else {								// On Heroku. No SSL needed
	var http = require('http');
	var server = http.Server(app);
	server.listen(PORT, function() {
		console.log("Server running on ",PORT);
	});
}

const request = require('request');					// Used to access cloud storage RestAPI 

// Client socket event and audio handling area
//
var io  = require('socket.io').listen(server, 
	{ cookie: false, log: false });					// socketIO for downstream connections

io.sockets.on('connection', function (socket) {
	console.log("New connection:", socket.id);
	socket.audiobuf = [];						// Buffer for storing client audio recording
	socket.playhead = 0;						// PLayback position in audio buffer
	socket.recording = false;					// Flags to indicate if client is recording
	socket.playing = false;						// or playing back

	socket.on('disconnect', function () {
		console.log("User disconnected:", socket.id);
	});

	socket.on('upstreamHi', function (data) { 			// A client requests to connect with an ID
		console.log("New client ", socket.id," with dir ",data.id);
		socket.client_id = data.id;
		let guide = data.id.substring(0,1);			// Capture the guide this user is requesting
		fs.readdir("./public/guides/", (err, files) => {	// Read the guides available, filter and send to client
			let pattern = new RegExp(guide + "-[0-9]*-[FBAS]");
			files = files.filter(function (str) {return pattern.test(str);});
			socket.emit('g', {files:files});		// Send a "g"uide message with ordered list of guide steps
		});
	});

	socket.on('Record', function () {				// Command from client to start recording their audio
		console.log("Record ", socket.client_id);
		socket.recording = true;
		socket.playing = false;
	});

	socket.on('Play', function () {					// Command from client to start playing their recorded audio
		console.log("Play ", socket.client_id);
		if (socket.audiobuf.length > 0) {			// If there is audio recorded then start playback
			socket.recording = false;
			socket.playing = true;
			socket.playhead = 0;
		}
	});

	socket.on('Stop', function () {					// Command from client to stop playing or recording their audio
		console.log("Stop ", socket.client_id);
		socket.recording = false;
		socket.playing = false;
		socket.emit('s');					// Send stop confirm to client
	});

	socket.on('u', function (packet) { 				// Audio coming up of our downstream clients
		if (clientPacketBad(packet)) {
			console.log("Bad client packet");
			return;
		}
		if (socket.recording) 					// If recording add audio to audio packet buffer
			socket.audiobuf.push(packet.audio);
		let audio;						// Audio to send back to client
		if (socket.playing) {					// If playing back recording
			audio = socket.audiobuf[socket.playhead++];	// reproduce audio from audio packet buffer
			if (socket.audiobuf.length == socket.playhead) {// If we have reached the end of the recorded audio buffer
				socket.playing = false;			// stop playing
				socket.emit('s');			// & send client the event that playing has stopped
			}
		} else audio = packet.audio;				// otherwise send client's audio back to them
		socket.emit('d', {					// Send audio back to client
			audio		: audio,			
		});
	});
});

function clientPacketBad(p) {						// Perform basic checks on packets to stop basic hacks
	return false;
}

