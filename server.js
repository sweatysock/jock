// Voicevault server
// 
// Mark Gemmell Feb 2021
//

const SampleRate = 32000; 						// All audio runs at this sample rate regardless of the client hardware
const PacketSize = 1000;							// Number of samples in the client audio packets
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

	socket.on('disconnect', function () {
		console.log("User disconnected:", socket.id);
	});

	socket.on('upstreamHi', function (data) { 			// A client requests to connect with an ID
		console.log("New client ", socket.id," with dir ",data.id);
		socket.client_id = data.id;
	});

	socket.on('superHi', function (data) {				// A supervisor is registering for status updates PROTECT
		console.log("New super ", socket.id);
		socket.join('supers');					// Add them to the supervisor group
	});

	socket.on('u', function (packet) { 				// Audio coming up of our downstream clients
		if (clientPacketBad(packet)) {
			console.log("Bad client packet");
			return;
		}
		socket.emit('d', {					// Send audio back to client
			audio		: packet.audio,			
		});
console.log("audio from client with id ",socket.client_id);
	});
});

function clientPacketBad(p) {						// Perform basic checks on packets to stop basic hacks
	return false;
}

