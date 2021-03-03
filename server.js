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

// OAuth2 handling for OneDrive
//
const clientID = "1cb0b9a5-058b-4224-a31e-7da7f1d82829";
const clientSecret = "1n3~PGlmw4xMpaz~hhmq12Na._V-Z9SZ97";
const scope = "offline_access files.readwrite";
var callback = "https://voicevault.herokuapp.com/authCallback";
if (PORT == undefined) callback = "https://localhost/authCallback";
app.get("/login", function (req, res, next) {
	let url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
	let param = {
		response_type: "code",
		client_id: clientID,
		redirect_uri: domain + "authCallback",
		state: "12345",
		scope: scope,
	};
	let params = [];
	for (var name in param) {
		params.push(name + "=" + encodeURIComponent(param[name]));
	}
	var html = '<input type="button" value="auth" onclick="window.open(\'' + url + "?" +
	params.join("&") +
	"', 'Authorization', 'width=500,height=600');\">";
	res.send("Please authenticate in OneDrive: "+html);
	next();
});

app.get("/authCallback", function (req, res, next) {
	res.send("OneDrive auth callback");
	next();
}


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

	socket.on('Save', function () {					// Command from client to save recorded audio
		console.log("Save ", socket.client_id);
		socket.recording = false;
		socket.playing = false;
		saveRecording(socket.audiobuf);
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

//var lame = require('lame');
var wav = require('node-wav');
//var stream = require('stream');
function saveRecording(audioBuf) {					// Save recorded audio packets to an MP3 file
	let audio = [];
	audioBuf.forEach( function(zippedAudio) {			// Get all audio in packet buffer into a single buffer
		let a = zipson.parse(zippedAudio);
		audio.push(...a);
	});
	audio = (new Array(3)).fill((audio));
	let buffer = wav.encode(audio, {sampleRate: 32000, float: true, bitDepth: 64});
	fs.writeFile("out.wav", buffer, (err) => {
		if (err)  return console.log(err);
		console.log("out.wav created");
	});

//	let encoder = new lame.Encoder({				// Use lame to encode audio as MP3
//		// input
//		channels: 1,        
//		bitDepth: 32, 
//		sampleRate: 32000, 
//		// output
//		bitRate: 128,
//		outSampleRate: 32000,
//		mode: lame.MONO 
//	});
//	let bufferStream = new stream.PassThrough();			// Pipe to pass audio through to encoder and on to file
//	bufferStream.end(Buffer.from(audio));				// Audio gets fed into pipe
//	let fileWriter = new wav.FileWriter('out.wav', {		// Output is a wav file
//		channels: 1,
//		sampleRate: 32000,
//		bitDepth: 32
//	});
//	bufferStream.pipe(fileWriter);					// Pipe audio stream to wav file
//	bufferStream.pipe(encoder);					// and then to the encoder
//	encoder.pipe(fs.createWriteStream('out.mp3');			// and from there to the output file
//	bufferStream.pipe(fs.createWriteStream('out.mp3'));
}
