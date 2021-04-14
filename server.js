////////////////////////////////////////////////////////////////////////// Voicevault server
// 
// Mark Gemmell Feb 2021
//

const SampleRate = 32000; 						// All audio runs at this sample rate regardless of the client hardware
const PacketSize = 1000;						// Number of samples in the client audio packets
var zipson = require('zipson');						// For compressing and decompressing data

////////////////////////////////////////////////////////////////////////// Network code
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

////////////////////////////////////////////////////////////////////////// OneDrive code
//
const request = require('request');					// Used to access cloud storage RestAPI 
const async = require('async');						// Used for asynchronous large file uploads

// OAuth2 handling for OneDrive
//
var clientID = "1cb0b9a5-058b-4224-a31e-7da7f1d82829";			// These are default values for testing
var clientSecret = "1n3~PGlmw4xMpaz~hhmq12Na._V-Z9SZ97";
if (process.env.clientID != undefined) clientID = process.env.clientID;	// If we are running in Heroku these should be set
if (process.env.clientSecret != undefined) clientSecret = process.env.clientSecret;
const scope = "offline_access files.readwrite";				// Scope of access required for OneDrive
var callback = "https://voicevault.herokuapp.com/authcallback";		// Authentication callback varies if on heroku
if (PORT == undefined) callback = "https://localhost/authcallback";	// or running as localhost for testing
accessToken = "";							// This needs to be valid to allow us to work with OneDrive
refreshToken = "";							// To renew the access token we need this to be valid. Otherwise OndeDrive owner must re-authenticate
fs.readFile("rt.txt", function (err, text) {				// Try reading the refresh token saved from a previous session
	if (err)  return console.log("Error loading previous refresh token:",err);
	refreshToken = text;
	console.log("Refresh token read from cache file: ", refreshToken);
	let now = new Date();
	saveTextFile("System/", "launched", "voicevault started on "+now+" using recovered token.");
});


app.get("/authorize", function (req, res, next) {			// When the refresh token expires the OneDrive owner needs to re-authorize us here
	let url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
	let param = {							// Parameters for OAuth2 authorization call to Microsoft
		response_type: "code",
		client_id: clientID,
		redirect_uri: callback,
		state: "12345",
		scope: scope,
	};
	let params = [];
	for (var name in param) {					// Turn parameters into valid URL
		params.push(name + "=" + encodeURIComponent(param[name]));
	}
	res.redirect(url+"?"+params.join("&"));
	next();
});

app.get("/authcallback", function (req, res, next) {			// Microsoft will send the user here if we get authotization
	res.status(200).send("OneDrive authorization complete. You may close this window.");
	console.log("OneDrive auth callback. code is "+req.query.code);
	let payload = {
		code: req.query.code,
		client_id: clientID,
		client_secret: clientSecret,
		redirect_uri: callback,
		grant_type: "authorization_code",
	};
	request.post({							// Use the authorization code to get new access and refresh tokens
		headers: {'content-type' : 'application/x-www-form-urlencoded'},
		url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
		form: payload,
	}, function(error, response, body){				// If all goes well the response will contain the tokens
		console.log("Microsoft authentication error code:", error);
		console.log("Microsoft authentication results:");
		console.log(body);
		let results = JSON.parse(body);
		accessToken = results.access_token;
		refreshToken = results.refresh_token;
		fs.writeFile("rt.txt", refreshToken, (err) => {		// Save the refresh token so it can be recovered on restarting
			if (err)  return console.log(err);
			console.log("rt.txt created");
			let now = new Date();
			saveTextFile("System/", "auth", "New authentication obtained correctly on "+now);
		});
	});
	next();
});

// OneDrive general operations
//
function checkFolderExists(name) {					// Tests if a specific folder exists in OneDrive
	return new Promise(function( resolve, reject ) {		// Returns a promise with success or failure
		request.post({						// First get a new access token
			url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
			form: {
				redirect_uri: callback,
				client_id: clientID,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: 'refresh_token'
			},
		}, function(error, response, body) {			// Response from Microsoft obtained
			if (error) {					// Error checking
				console.log("Error obtaining access token: ", error, body);
				refreshToken = "";
				io.sockets.emit('a');			// Send an "a"uthorization error to all connected clients
				return reject(error);
			}						
			body = JSON.parse(body);
			if (body.error) {
				console.log("Error in body after requesting access token: ");
				console.log(body);
				refreshToken = "";
				io.sockets.emit('a');			// Send an "a"uthorization error to all connected clients
				return reject(body.error);
			}						// No errors if we get to this point
			request.get({					// Check if the folder (item) exists
				url: 'https://graph.microsoft.com/v1.0/drive/root:/VoiceVault/' + name,
				headers: {
					'Authorization': "Bearer " + body.access_token,
					'Content-Type': "text/plain",
				},
			}, function(er, re, bo) {			// Process any errors first
				if (er) return reject(er);		// If the folder doesn't exist return false
				bo = JSON.parse(bo);
				if (bo.error) {
					console.log("Error in body after calling OneDrive API to check if folder exists: ");
					console.log(bo);
					return reject(bo.error);	// If the folder doesn't exist return false
				}
				try {					// Otherwise try the route of success
					resolve();
				} catch(e) {
					reject(e);
				}
			});
		});
	});
}

// NOTE: This can only create folders in the root directory right now. When specifying a sub folder it gives an API error
function createFolder(folder, name) {					// Creates a new folder called name in folder in OneDrive
	return new Promise(function( resolve, reject ) {		// Returns a promise with success or failure
		request.post({						// First get a new access token
			url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
			form: {
				redirect_uri: callback,
				client_id: clientID,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: 'refresh_token'
			},
		}, function(error, response, body) {			// Response from Microsoft obtained
			if (error) {					// Error checking
				console.log("Error obtaining access token: ", error, body);
				refreshToken = "";
				io.sockets.emit('a');			// Send an "a"uthorization error to all connected clients
				return reject(error);
			}						
			body = JSON.parse(body);
			if (body.error) {
				console.log("Error in body after requesting access token: ");
				console.log(body);
				refreshToken = "";
				io.sockets.emit('a');			// Send an "a"uthorization error to all connected clients
				return reject(body.error);
			}						// No errors if we get to this point
console.log('POST to https://graph.microsoft.com/v1.0/drive/root/'+folder+'children');
			request.post({					// Create the folder (item) with <name>
				url: 'https://graph.microsoft.com/v1.0/drive/root/'+folder+'children',
				headers: {
					'Authorization': "Bearer " + body.access_token,
					'Content-Type': "application/json",
				},
				body: '{"@microsoft.graph.conflictBehavior": "replace", "folder": {}, "name": "' + name + '"}',
			}, function(er, re, bo) {			// Process any errors first
				if (er) return reject(er);		// If the folder doesn't exist return false
				bo = JSON.parse(bo);
				if (bo.error) {
					console.log("Error in body after calling OneDrive API to create new folder ",name," in folder ",folder,": ");
					console.log(bo);
					return reject(bo.error);	// If the folder doesn't exist return false
				}
				try {					// Otherwise try the route of success
					resolve();
				} catch(e) {
					reject(e);
				}
			});
		});
	});
}

// File uploads to OneDrive
//
function saveTextFile(folder, name, text) {				// Saves a simple text file to the OneDrive directory for this session
	name = name + ".txt";						// Saving a text file with extension .txt
	console.log("Saving file ",name, "with content ",text);
	request.post({							// First get a new access token
		url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
		form: {
			redirect_uri: callback,
			client_id: clientID,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: 'refresh_token'
		},
	}, function(error, response, body) {				// Response from Microsoft obtained
		if (error) {						// Error checking
			console.log("Error obtaining access token: ", error, body);
			refreshToken = "";
			io.sockets.emit('a');				// Send an "a"uthorization error to all connected clients
			return;
		}						
		body = JSON.parse(body);
		if (body.error) {
			console.log("Error in body after requesting access token: ");
			console.log(body);
			refreshToken = "";
			io.sockets.emit('a');				// Send an "a"uthorization error to all connected clients
			return;
		}							// No errors if we get to this point
		request.put({						// Create a new file in OneDrive
			url: 'https://graph.microsoft.com/v1.0/drive/root:/VoiceVault/' + folder + name + ':/content?@microsoft.graph.conflictBehavior=rename',
			headers: {
				'Authorization': "Bearer " + body.access_token,
				'Content-Type': "text/plain",
			},
			body: text,					// File content goes here
		}, function(er, re, bo) {				// Process any errors
			if (er) return console.log("Upload small file session error: ", er);
			bo = JSON.parse(bo);
			if (bo.error) {
				console.log("Error in body after calling OneDrive API to write small file: ");
				console.log(bo);
			}
		});
	});
}

var wav = require('node-wav');						// We use WAV encoding for now
function saveAudioFile(folder, name, audio) {				// Saves a buffer of compressed audio packets to the OneDrive test directory as a WAV file
	let buffer = [];						// Where all the WAV data will end up
	audio.forEach( function(zippedAudio) {				// Get all audio in packet buffer into a single buffer
		let a = zipson.parse(zippedAudio);
		buffer.push(...a);
	});
	buffer = (new Array(3)).fill((buffer));
	buffer = wav.encode(buffer, {sampleRate: 32000, float: true, bitDepth: 64});
	name = name+".wav";
	console.log("Saving WAV file ",name," (",buffer.length," bytes long)");
	request.post({							// First get a new access token
		url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
		form: {
			redirect_uri: callback,
			client_id: clientID,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: 'refresh_token'
		},
	}, function(error, response, body) {				// Response from Microsoft obtained
		if (error) {						// Error checking
			console.log("Error obtaining access token: ", error, body);
			refreshToken = "";
			io.sockets.emit('a');				// Send an "a"uthorization error to all connected clients
			return;
		}							
		body = JSON.parse(body);
		if (body.error) {
			console.log("Error in body after requesting access token: ");
			console.log(body);
			refreshToken = "";
			io.sockets.emit('a');				// Send an "a"uthorization error to all connected clients
			return;
		}							// No errors if we get to this point
		request.post({						// Create a new large file in OneDrive using a POST
			url: 'https://graph.microsoft.com/v1.0/drive/root:/VoiceVault/' + folder + name + ':/createUploadSession',
			headers: {					// We aim to get an upload session URL from this
				'Authorization': "Bearer " + body.access_token,
				'Content-Type': "application/json",
			},
			body: '{"item": {"@microsoft.graph.conflictBehavior": "rename", "name": "' + name + '"}}',
		}, function(er, re, bo) {				// Process any errors
			if (er) return console.log("Upload audio file session request error: ", er);
			bo = JSON.parse(bo);
			if (bo.error) {
				console.log("Error in body after calling OneDrive API to write audio file: ");
				console.log(bo);
				return;					
			}						// If we get to here all is good so 
			uploadFile(bo.uploadUrl, buffer);		// launch large file upload in blocks to the given URL
		});
	});
}

function uploadFile(uploadUrl, data) { 					// Upload a block of data in chunks
	async.eachSeries(getparams(data.length), function(st, callback){// Slice the file into 60MB blocks
		setTimeout(function() {					// and call this function in series for each block
			request.put({					// PUT the block to the URL
				url: uploadUrl,
				headers: {
					'Content-Length': st.clen,
					'Content-Range': st.cr,
				},
				body: data.slice(st.bstart, st.bend + 1),// The audio block is here
			}, function(er, re, bo) {			// Process errors
				if (er) return console.log("Upload large file block error: ", er);
				bo = JSON.parse(bo);
				if (bo.error) {
					console.log("Error in body after calling OneDrive API to write large file: ");
					console.log(bo);
					return;
				}
			});
			callback();
		}, st.stime);
	});
}

function getparams(size){						// Build array of blocks to send with relevant params for PUT operation
	let sep = size < (60 * 1024 * 1024) ? size : (60 * 1024 * 1024) - 1;
	let ar = [];
	for (var i = 0; i < size; i += sep) {
		let bstart = i;
		let bend = i + sep - 1 < size ? i + sep - 1 : size - 1;
		let cr = 'bytes ' + bstart + '-' + bend + '/' + size;
		let clen = bend != size - 1 ? sep : size - i;
		let stime = size < (60 * 1024 * 1024) ? 5000 : 10000;
		ar.push({
			bstart : bstart,
			bend : bend,
			cr : cr,
			clen : clen,
			stime: stime,
		});
	}
	return ar;
}


////////////////////////////////////////////////////////////////////////// Client socket event and audio handling area
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
		if (refreshToken === "") return socket.emit('a');	// Send an "a"uthorization error to client and quit there
		checkFolderExists("Patients/"+data.id).then(function() {;
			console.log("ID hass been confirmed. Getting guides for patient: ", data.id);
			socket.clientID = data.id;
			let guide = data.id.substring(0,1);		// Capture the guide this user is requesting
			fs.readdir("./public/guides/", (err, files) => {// Read the guides available, filter and send to client
				let pattern = new RegExp(guide + "-[0-9]*-[FBAS]");
				files = files.filter(function (str) {return pattern.test(str);});
				console.log("got guide ",guide," files for client: ",files);
				socket.emit('g', {files:files});	// Send a "g"uide message with ordered list of guide steps
			});
		}).catch(function(err){
			console.log("Rejecting connection with invalid ID: ",data.id);
			socket.disconnect();
		});
	});

	socket.on('Record', function () {				// Command from client to start recording their audio
		console.log("Record ", socket.clientID);
		socket.recording = true;
		socket.playing = false;
		socket.audiobuf = [];					// Empty the audiobuf of any previous recording
	});

	socket.on('Play', function () {					// Command from client to start playing their recorded audio
		console.log("Play ", socket.clientID);
		if (socket.audiobuf.length > 0) {			// If there is audio recorded then start playback
			socket.recording = false;
			socket.playing = true;
			socket.playhead = 0;
		}
	});

	socket.on('Stop', function () {					// Command from client to stop playing or recording their audio
		console.log("Stop ", socket.clientID);
		socket.recording = false;
		socket.playing = false;
		socket.emit('s');					// Send stop confirm to client
	});

	socket.on('Save', function (packet) {				// Command from client to save recorded audio
		console.log("Save ", socket.clientID," ",packet.stepFile," ",packet.text);
		let step = packet.stepFile.slice(0,				// Remove the file extension from the guide step
			packet.stepFile.lastIndexOf("."));			// We will use this as the file name for the response + extension
		let guideType = 					// Derive the guide step from the step name
			packet.stepFile[packet.stepFile.lastIndexOf("-")+1];
		switch (guideType) {
			case "A":					// Audio step. Save recording in folder (ID) and filename (step)
				saveAudioFile("Patients/"+socket.clientID+"/", step, socket.audiobuf);
				break;
			case "S":
			case "B":					// Step was a true/false question or a rating on a scale of 1-10
				saveTextFile("Patients/"+socket.clientID+"/", step, packet.text);
				break;
		}
		socket.recording = false;
		socket.playing = false;
	});

	socket.on('u', function (packet) { 				// Audio coming up from our downstream clients
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

// Supervisor. Checks everything is good with OneDrive every minute
//
function supervisor() {
	let now = new Date();
	saveTextFile("System/", "ping", "VoiceVault pinging oneDrive on "+now);
}
setInterval(supervisor, 60000);						// Call supervisor every minute

//var lame = require('lame');
//var stream = require('stream');
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
