// Voicevault client
//
// Mark Gemmell Feb 2021
//

const SampleRate = 32000; 						// Global sample rate used for all audio
const PacketSize = 1000;						// Server packet size we must conform to
const HighFilterFreq = SampleRate/2.2;					// Mic filter to remove high frequencies before resampling
const LowFilterFreq = 30;						// Mic filter to remove low frequencies before resampling
const ChunkSize = 4096*4;							// Audio chunk size. Fixed by js script processor
var soundcardSampleRate = null; 					// Get this from context 
var micPacketSize = 0;							// Calculate this once we have soundcard sample rate
var socketConnected = false; 						// True when socket is up
var micAccessAllowed = false; 						// Need to get user permission
var spkrBuffer = []; 							// Audio buffer going to speaker
var smoothingNeeded = false;						// Flag to indicate if output smoothing needed after a shortage
var maxBuffSize = 20000;						// Max audio buffer chunks for playback. 
var micBuffer = [];							// Buffer mic audio before sending
var myDir = "";								// Name assigned to my audio channel
var micIn = {								// and for microphone input
	gain	: 0,							// Gain level for mic
	gainRate: 100,							// Speed of gain adjustment
	targetGain: 1,							// Final target gain for mic
	ceiling : 1,							// Temporary gain level for special audio control
	agc	: true,							// Control if mic is to have gain auto controlled
	peak	: 0,							// Peak mic level
	muted	: false,						// Mute control for mic
};
var smooth = [];							// Pre-populated array of values for smooth overflow/shortage transations
for (let i=0; i<400; i++)
	smooth[i] = Math.cos(i/400*Math.PI)/2 + 0.5;
var monitor = false;							// Flag to switch audio output on/off
var outPeak = 0;							// peak output used for display
var guideStep = 0;							// Start guide at first step
var guideName = "";							// Guide name is derived from ID
var guides = [];							// List of guide steps
var responseText = "";

// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {				// New connection coming in
	trace('socket connected!');
	let urlParams = new URLSearchParams(window.location.search);	
	myID = urlParams.get('id');					// Get our ID from the URL
	guideName = myID.substring(0, myID.indexOf("-"));		// Get guide name which is the string up to a "-" in the ID
	socketIO.emit("upstreamHi",{id:myID});				// Register with server supplying the ID
	socketConnected = true;						// The socket can be used once we have a channel
});

socketIO.on('d', function (data) { 					// Audio data coming in from server
	packetsIn++;
	if (!micAccessAllowed) {					// Need access to audio before outputting
		return;							// No audio access so do nothing with incoming data
	}
	let audio = zipson.parse(data.audio);				// Uncompress audio
	audio = reSample(audio, upCache, micPacketSize); 		// Upsample back to local HW sample rate
	spkrBuffer.push(...audio);					// put left mix in the left speaker buffer
	if (spkrBuffer.length > maxBuffSize) {				// If too full merge final 400 samples
		overflows++;
		spkrBuffer.splice(maxBuffSize/2,maxBuffSize/2);		// Chop buffer in half
	}
});

socketIO.on('g', function (data) { 					// List of guide steps to follow
	guideStep = 0;
	guides = data.files;						// Store the list of guide steps
	loadGuide();
});

socketIO.on('s', function (data) {					// Playing or recording has stopped
	stopOff.style.visibility = "visible";				// Disable stop button
	monitor = false;						// Turn off monitor in case we were paying our recording back
});

socketIO.on('disconnect', function () {
	trace('socket disconnected!');
	socketConnected = false;
});





// Media management and display code 
//
function checkOrientation() {						// Check screen aspect ratio and move guide and controls accordingly
	let guide = document.getElementById('guide');
	let controls = document.getElementById('controls');
	if (window.innerWidth > window.innerHeight) {
		guide.style.width = "45%";
		controls.style.width = "45%";
		guide.style.height = "90%";
		controls.style.height = "90%";
	} else {
		guide.style.width = "90%";
		controls.style.width = "90%";
		guide.style.height = "45%";
		controls.style.height = "45%";
	}
	let scaleVal = document.getElementById('scaleVal');
	scaleVal.style.fontSize = scaleVal.clientHeight/2 + "px";
}

function updateScale(value) {
	let scaleVal = document.getElementById('scaleVal');
	scaleVal.innerHTML = value;
	responseText = value + " ";					// Store the response for sending to server
	let nextOff = document.getElementById("nextOff");
	nextOff.style.visibility = "hidden";				// Enable the next button as a value has been input
}

document.addEventListener('DOMContentLoaded', function(event){		// Add dynamic behaviour to UI elements
	tracef("Starting V1.0");
	checkOrientation();
	window.addEventListener('resize', checkOrientation );
	let nextBtn = document.getElementById("nextBtn");
	let recBtn = document.getElementById("recBtn");
	let playBtn = document.getElementById("playBtn");
	let trueBtn = document.getElementById("trueBtn");
	let exBtn = document.getElementById("exBtn");
	let stopBtn = document.getElementById("stopBtn");
	let falseBtn = document.getElementById("falseBtn");
	let nextOff = document.getElementById("nextOff");
	let stopOff = document.getElementById("stopOff");
	let playOff = document.getElementById("playOff");
	let exOff = document.getElementById("exOff");
	let trueActive = document.getElementById("trueActive");
	let falseActive = document.getElementById("falseActive");
	let exAudio = document.getElementById("exAudio");
	nextBtn.onclick = function () {
		socketIO.emit("Save", {					// Tell the server to save responses
			stepFile: guides[guideStep], 			// corresponding to this step file of the guide
			text: responseText,				// with response texts if appropriate
		});	
		guideStep++;
		loadGuide();
	};
	recBtn.onclick = function () {
		exAudio.pause();					// Stop example audio playing
		stopOff.style.visibility = "hidden";			// Enable stop button
		nextOff.style.visibility = "hidden";			// Enable next button as recording has started
		playOff.style.visibility = "hidden";			// Enable play button too
		socketIO.emit("Record");				// Send command to server
		monitor = false;					// Turn off monitor while recording
	};
	playBtn.onclick = function () {
		exAudio.pause();					// Stop example audio playing
		stopOff.style.visibility = "hidden";			// Enable stop button
		socketIO.emit("Play");					// Send command to server
		monitor = true;
	};
	trueBtn.onclick = function () {
		trueActive.style.visibility = "visible";
		falseActive.style.visibility = "hidden";
		nextOff.style.visibility = "hidden";			// Enable the next button as a value has been input
		responseText = "true";					// Store the response for sending to server
	};
	falseBtn.onclick = function () {
		trueActive.style.visibility = "hidden";
		falseActive.style.visibility = "visible";
		nextOff.style.visibility = "hidden";			// Enable the next button as a value has been input
		responseText = "false";					// Store the response for sending to server
	};
	exAudio.onloadeddata = function () {				// When example audio is loaded enable the button
		exOff.style.visibility = "hidden";
	};
	exAudio.onended = function () {					// When example audio has finished playing
		stopOff.style.visibility = "visible";
	};
	exBtn.onclick = function () {					// Example audio button pressed
		exAudio.currentTime = 0;				// Reset file to start
		exAudio.play();						// Play the audio
		stopOff.style.visibility = "hidden";			// Enable the stop button
	};
	stopBtn.onclick = function () {					// Stop button pressed
		exAudio.pause();					// Stop audio
		stopOff.style.visibility = "visible";			// Disable stop button
		socketIO.emit("Stop");					// Send command to server
	};
});

function setStatusLED(name, level) {					// Set the status LED's colour
	let LED = document.getElementById(name);
	if (level == "Red") LED.className="redLED";
	else if (level == "Orange") LED.className="orangeLED";
	else LED.className="greenLED";
}

function loadGuide() {							// Loads the next step in the guide
	let guide = guides[guideStep];
	let filename = "/guides/"+guide;
	let guideImage = document.getElementById("guideImage");
	let guideType = guide[guide.lastIndexOf("-")+1];
console.log(filename," ",guideType);
	guideImage.style.visibility = "hidden";
	guideImage.src = filename;
	guideImage.onerror = guideComplete;
	guideImage.onload = function () {
		this.style.visibility = "visible";			// Guide step image has loaded. Make it visible.
		let ex = document.getElementById("ex");			// Get all the control elements and their disable elements too
		let exOff = document.getElementById("exOff");
		let rec = document.getElementById("rec");
		let recOff = document.getElementById("recOff");	
		let play = document.getElementById("play");
		let playOff = document.getElementById("playOff");
		let stop = document.getElementById("stop");
		let stopOff = document.getElementById("stopOff");
		let trueCtrl = document.getElementById("trueCtrl");
		let trueActive = document.getElementById("trueActive");
		let falseCtrl = document.getElementById("falseCtrl");
		let falseActive = document.getElementById("falseActive");
		let scale = document.getElementById("scale");
		let next = document.getElementById("next");
		let nextOff = document.getElementById("nextOff");
		let complete = document.getElementById("testComplete");
		switch (guideType) {					// Set initial button states for each guide step type
			case "A":
				ex.style.visibility = "visible";
				exOff.style.visibility = "visible";
				rec.style.visibility = "visible";
				recOff.style.visibility = "hidden";
				play.style.visibility = "visible";
				playOff.style.visibility = "visible";
				stop.style.visibility = "visible";
				stopOff.style.visibility = "visible";
				trueCtrl.style.visibility = "hidden";
				trueActive.style.visibility = "hidden";
				falseCtrl.style.visibility = "hidden";
				falseActive.style.visibility = "hidden";
				scale.style.visibility = "hidden";
				next.style.visibility = "visible";	
				nextOff.style.visibility = "visible";
				complete.style.visibility = "hidden";
				let exAudio = document.getElementById("exAudio");
				let filename = "/guides/"+guide.substring(0,guide.lastIndexOf("-")+1) + "Ex.m4a";
console.log("loading example audio ",filename);
				exAudio.setAttribute("src",filename);
				break;
			case "S":
				ex.style.visibility = "hidden";
				exOff.style.visibility = "hidden";
				rec.style.visibility = "hidden";
				recOff.style.visibility = "hidden";
				play.style.visibility = "hidden";
				playOff.style.visibility = "hidden";
				stop.style.visibility = "hidden";
				stopOff.style.visibility = "hidden";
				trueCtrl.style.visibility = "hidden";
				trueActive.style.visibility = "hidden";
				falseCtrl.style.visibility = "hidden";
				falseActive.style.visibility = "hidden";
				scale.style.visibility = "visible";
				next.style.visibility = "visible";	
				nextOff.style.visibility = "visible";
				complete.style.visibility = "hidden";
				break;
			case "B":
				ex.style.visibility = "hidden";
				exOff.style.visibility = "hidden";
				rec.style.visibility = "hidden";
				recOff.style.visibility = "hidden";
				play.style.visibility = "hidden";
				playOff.style.visibility = "hidden";
				stop.style.visibility = "hidden";
				stopOff.style.visibility = "hidden";
				trueCtrl.style.visibility = "visible";
				trueActive.style.visibility = "hidden";
				falseCtrl.style.visibility = "visible";
				falseActive.style.visibility = "hidden";
				scale.style.visibility = "hidden";
				next.style.visibility = "visible";	
				nextOff.style.visibility = "visible";
				complete.style.visibility = "hidden";
				break;
			case "F":
				ex.style.visibility = "hidden";
				exOff.style.visibility = "hidden";
				rec.style.visibility = "hidden";
				recOff.style.visibility = "hidden";
				play.style.visibility = "hidden";
				playOff.style.visibility = "hidden";
				stop.style.visibility = "hidden";
				stopOff.style.visibility = "hidden";
				trueCtrl.style.visibility = "hidden";
				trueActive.style.visibility = "hidden";
				falseCtrl.style.visibility = "hidden";
				falseActive.style.visibility = "hidden";
				scale.style.visibility = "hidden";
				next.style.visibility = "hidden";	// Hide the next button as this is the final step
				complete.style.visibility = "hidden";	// If we fail to load an image this will show, otherwise keep hidden
				break;
			default:
console.log("Unknown guide step type");
		}
	}
}

function guideComplete() {						// If a guide image doesn't load we assume the guide is done
	let guideImage = document.getElementById("guideImage");
	guideImage.style.visibility = "hidden";
	let complete = document.getElementById("testComplete");
	complete.style.visibility = "visible";
}


// Audio management code
//

function maxValue( arr ) { 						// Find max value in an array
	let max = 0;	
	let v;
	for (let i =  0; i < arr.length; i++) {
		v = Math.abs(arr[i]);					// max ABSOLUTE value
		if (v > max) max = v;
	}
	return max;
}

function applyAutoGain(audio, obj) {
	let startGain = obj.gain;
	let targetGain = obj.targetGain;
	let ceiling = obj.ceiling;
	let negCeiling = ceiling * -1;
	let gainRate = obj.gainRate;
	let agc = obj.agc;
	let tempGain, maxLevel, endGain, p, x, transitionLength; 
	if (!agc) targetGain = startGain;				// If no AGC not much to do. Just clip and apply ceiling
	maxLevel = maxValue(audio);					// Find peak audio level 
	if ((maxLevel * targetGain) > ceiling) { 			// If applying target gain level takes us over the ceiling
		endGain = ceiling / maxLevel;				// end gain is set such that the max level IS ceiling
		trace2("Clipping gain");				// Indicate that clipping has been avoided
	} else {
		endGain = targetGain;					// otherwise end gain is the target gain
	}
	maxLevel = 0;							// Use this to capture peak
	if (endGain >= startGain) {					// Gain adjustment speed varies
		transitionLength = audio.length;			// Gain increases are over entire sample
		if (agc) endGain = startGain 				// and, if using AGC, are very gentle
			+ ((endGain - startGain)/gainRate);	 	
	}
	else {
		transitionLength = Math.floor(audio.length/10);		// Gain decreases are fast
		trace2("Gain dropping");
	}
	tempGain = startGain;						// Start at current gain level
	for (let i = 0; i < transitionLength; i++) {			// Adjust gain over transition
		x = i/transitionLength;
		tempGain = startGain + (endGain - startGain) * x;
	 	audio[i] = audio[i] * tempGain;
		if (audio[i] >= ceiling) audio[i] = ceiling;
		else if (audio[i] <= negCeiling) audio[i] = negCeiling;
		x = Math.abs(audio[i]);
		if (x > maxLevel) maxLevel = x;
	}
	if (transitionLength != audio.length) {				// Still audio left to adjust?
		tempGain = endGain;					// Apply endGain to rest
		for (let i = transitionLength; i < audio.length; i++) {
			audio[i] = audio[i] * tempGain;
			if (audio[i] >= ceiling) audio[i] = ceiling;
			else if (audio[i] <= negCeiling) audio[i] = negCeiling;
			x = Math.abs(audio[i]);
			if (x > maxLevel) maxLevel = x;
		}
	}
	if (ceiling != 1) endGain = startGain;				// If talkover ceiling impact on gain is temporary
	return { finalGain: endGain, peak: maxLevel };
}

function processAudio(e) {						// Main processing loop
	// There are two activities here 
	// 1. Get Mic audio, down-sample it, buffer it, and, if enough, send to server
	// 2. Get audio buffered from server and send to speaker

	let inData = e.inputBuffer.getChannelData(0);			// Audio from the mic
	let outData = e.outputBuffer.getChannelData(0);			// Audio going to the speaker
micChunks++;
return;
	// 1. Get Mic audio, buffer it, and send it to server if enough buffered
	if (socketConnected) {						// Need connection to send
		micBuffer.push(...inData);				// Buffer mic audio
		while (micBuffer.length > micPacketSize) {		// While enough audio in buffer 
			let audio = micBuffer.splice(0, micPacketSize);	// Get a packet of audio
			audio = reSample(audio, downCache, PacketSize);	
			let obj = applyAutoGain(audio, micIn);		// Amplify mic with auto limiter
			if (obj.peak > micIn.peak) 
				micIn.peak = obj.peak;			// Note peak for local display
			micIn.gain = obj.finalGain;			// Store gain for next loop
			if (micIn.muted) 				// If mic muted send silence
				audio = new Array(PacketSize).fill(0);
			let a = zipson.stringify(audio);		// Compress audio
			audio = a;	
			let packet = {
				audio		: audio,		// Audio block
			};
			socketIO.emit("u",packet);
			packetsOut++;
		}
	}

	// 2. Take audio buffered from server and send it to the speaker
	let outAudio = new Array(ChunkSize).fill(0);			// Start with silence
	if ((!smoothingNeeded)||(spkrBuffer.length > maxBuffSize/2)) {	// If no current shortages or buffer now full enough to restart
		if (spkrBuffer.length > ChunkSize) {			// There is enough audio buffered
			outAudio = spkrBuffer.splice(0,ChunkSize);	// Get same amount of audio as came in
			if (smoothingNeeded) {				// We had a shortage so now we need to smooth audio re-entry 
				for (let i=0; i<400; i++) {		// Smoothly ramp up from zero to one
					outAudio[i] = outAudio[i]*(1-smooth[i]);
				}
				smoothingNeeded = false;
			}
		} else {						// Not enough audio.
			shortages++;					// Log shortage
			let rem = [];
			rem = spkrBuffer.splice(0,spkrBuffer.length);	// Take all audio that remains and fade down
			let t = (rem.length < 400)? 			// Transition to zero is as long as remaining audio
				rem.length : 400;			// up to a maximum of 400 samples
			for (let i=0; i<t; i++) {			// Smoothly drop to zero to reduce harsh clicks
				outAudio[i] = rem[i]*smooth[Math.round(i*400/t)];
			}
			smoothingNeeded = true;				// Flag that a smooth fade up will be needed when audio returns
		}
	} else shortages++;						// Not enough audio so add to shortages
	let tempPeak = maxValue(outAudio);				// Capture output peak level for display
	if (tempPeak > outPeak) outPeak = tempPeak;
	if (monitor) {							// If the user has switched on output monitoring
		for (let i in outData)  outData[i] = outAudio[i];	// copy audio to output 
	} else {
		for (let i in outData) outData[i] = 0;			// else output is silent
	}
}


var micFilter1;								// Mic filters are adjusted dynamically
var micFilter2;
var context;
function handleAudio(stream) {						// We have obtained media access
	let AudioContext = window.AudioContext 				// Default
		|| window.webkitAudioContext 				// Safari and old versions of Chrome
		|| false; 
	if (AudioContext) {
		context = new AudioContext();
	} else {
		alert("Sorry, the Web Audio API is not supported by your browser. Consider upgrading or using Google Chrome or Mozilla Firefox");
	}
	soundcardSampleRate = context.sampleRate;			// Get HW sample rate... varies per platform
	micPacketSize = Math.round(PacketSize * 			// How much micAudio is needed to fill a Packet
		soundcardSampleRate / SampleRate);			// at our standard SampleRate (rounding error is an issue?)
tracef("samplerate=",soundcardSampleRate," micPacSz=",micPacketSize);
	micAccessAllowed = true;

	let liveSource = context.createMediaStreamSource(stream); 	// Create audio source (mic)
	let node = undefined;
	if (!context.createScriptProcessor) {				// Audio processor node
		node = context.createJavaScriptNode(ChunkSize, 1, 1);	// The new way is to use a worklet
	} else {							// but the results are not as good
		node = context.createScriptProcessor(ChunkSize, 1, 1);	// and it doesn't work everywhere
	}
	node.onaudioprocess = processAudio;				// Link the callback to the node

	micFilter1 = context.createBiquadFilter();			// Input low pass filter to avoid aliasing
	micFilter1.type = 'lowpass';
	micFilter1.frequency.value = HighFilterFreq;
	micFilter1.Q.value = 1;
	micFilter2 = context.createBiquadFilter();			// Input high pass filter to remove thumps
	micFilter2.type = 'highpass';
	micFilter2.frequency.value = LowFilterFreq;
	micFilter2.Q.value = 1;
	
	liveSource.connect(micFilter1);					// Mic goes to the lowpass filter
	micFilter1.connect(micFilter2);					// then to the highpass filter
	micFilter2.connect(node);					// then to the node where all the work is done
	node.connect(context.destination);				// and finally to the output
}

	
document.addEventListener('DOMContentLoaded', function(event){
	initAudio();							// Call initAudio() once loaded
});

function initAudio() {							// Set up all audio handling here
	let constraints = { 						// Try to get the right audio setup
		mandatory: {						// These don't really work though!
 			googEchoCancellation: false,
			googAutoGainControl: false,
			googNoiseSuppression: false,
			googHighpassFilter: false 
		}, 
		optional: [] 
	};
	navigator.getUM = (navigator.getUserMedia || navigator.webKitGetUserMedia || navigator.moxGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
	if (navigator.mediaDevices.getUserMedia) {			// The new way to request media
		trace("Using GUM with promise");			// is using .mediaDevices and promises
		navigator.mediaDevices.getUserMedia({  audio: constraints }) .then(function (stream) {
			handleAudio(stream);
		})
		.catch(function (e) { trace(e.name + ": " + e.message); });
	} else {							// Not everyone supports this though
		trace("Using OLD GUM");					// So use the old one if necessary
		navigator.getUM({ audio: constraints }, function (stream) {
			handleAudio(stream);
		}, function () { trace("Audio HW is not accessible."); });
	}
}


// Resampler
//
var  downCache = [0.0,0.0];						// Resampling cache for audio from mic
var  upCache = [0.0,0.0];						// Resampling cache for audio to speaker
function reSample( buffer, cache, resampledBufferLength) {		// Takes an audio buffer and stretches or shrinks it to fit the resampledBufferLength
	let resampleRatio = buffer.length / resampledBufferLength;
	let outputData = new Array(resampledBufferLength).fill(0);
	for ( let i = 0; i < resampledBufferLength - 1; i++ ) {
		let resampleValue = ( resampleRatio - 1 ) + ( i * resampleRatio );
		let nearestPoint = Math.round( resampleValue );
		for ( let tap = -1; tap < 2; tap++ ) {
			let sampleValue = buffer[ nearestPoint + tap ];
			if (isNaN(sampleValue)) sampleValue = cache[ 1 + tap ];
			if (isNaN(sampleValue)) sampleValue = buffer[ nearestPoint ];
			outputData[ i ] += sampleValue * magicKernel( resampleValue - nearestPoint - tap );
		}
	}
	cache[ 0 ] = buffer[ buffer.length - 2 ];
	cache[ 1 ] = outputData[ resampledBufferLength - 1 ] = buffer[ buffer.length - 1 ];
	return outputData;
}

// From http://johncostella.webs.com/magic/
function magicKernel( x ) {						// This thing is crazy cool
  if ( x < -0.5 ) {							// three curves that map x to y
    return 0.5 * ( x + 1.5 ) * ( x + 1.5 );				// in a harmonic-free manner
  }									// so that up and down sampling 
  else if ( x > 0.5 ) {							// is as clean as possible.
    return 0.5 * ( x - 1.5 ) * ( x - 1.5 );				// All this in 5 lines of code!
  }
  return 0.75 - ( x * x );
}



// Tracing, monitoring, reporting and debugging code
// 
var currentMonitor=0;
var monitors = ["none","monitor","monitor2"];
document.addEventListener('DOMContentLoaded', function(event){
	let monitorBtn=document.getElementById('monitorBtn');
	monitorBtn.onclick = function () {
		if (monitors[currentMonitor] != "none") {
			let mon = document.getElementById(monitors[currentMonitor])
			mon.style.visibility = "hidden";
			mon.parentNode.style.visibility = "hidden";
		}
		currentMonitor++;
		if (currentMonitor == monitors.length) currentMonitor = 0;
		if (monitors[currentMonitor] != "none") {
			let mon = document.getElementById(monitors[currentMonitor])
			mon.style.visibility = "visible";
			mon.parentNode.style.visibility = "visible";
		}
	};
	let micBtn=document.getElementById('micBtn');
	micBtn.onclick = function () {
		trace2("Mic mute button pressed");
		micIn.muted = !micIn.muted;
	};
	let outBtn=document.getElementById('outBtn');
	outBtn.onclick = function () {
		trace("Output button pressed");
		monitor = !monitor;
	};
});
var pauseTracing = false;						// Traces are on by default

// Reporting code. Accumulators, interval timer and report generator
//
var packetsIn = 0;
var packetsOut = 0;
var overflows = 0;
var shortages = 0;
var micChunks = 0;
function everySecond() {
	let upperLimit = SampleRate/PacketSize * 1.2;
	let lowerLimit = SampleRate/PacketSize * 0.8;
	let generalStatus = "Green";
	if ((overflows > 1) || (shortages >1) || 
		(packetsOut < lowerLimit) || 
		(packetsOut > upperLimit) || 
		(packetsIn < lowerLimit) || 
		(packetsIn > upperLimit)) generalStatus = "Orange";
	if ((socketConnected == false) ||
		(packetsOut < lowerLimit/3) ||
		(packetsIn < lowerLimit/3)) generalStatus = "Red";
	setStatusLED("GeneralStatus",generalStatus);
	let micStatus = "Green";
	if (micIn.peak > 0.95) micStatus = "Orange";
	if (micIn.peak == 0) micStatus = "Red";
	setStatusLED("micStatus",micStatus);
	let outStatus = "Green";
	if (outPeak > 0.95) outStatus = "Orange";
	if (outPeak == 0) outStatus = "Red";
	setStatusLED("outStatus",outStatus);
	trace("In=",packetsIn," Out=", packetsOut," micCh=",micChunks," Ov=", overflows," Sh=", shortages);
	packetsIn = 0;
	packetsOut = 0;
	overflows = 0;
	shortages = 0;
	micIn.peak = 0;
	outPeak = 0;
	micChunks = 0;
}
setInterval(everySecond, 10000);						// Call report generator and slow UI updater once a second


// Tracing to the traceDiv (a Div with id="Trace" in the DOM)
//
var traceDiv = null;
var traceDiv2 = null;
var traceArray = [];
var traceArray2 = [];
var maxTraces = 100;
document.addEventListener('DOMContentLoaded', function(event){
	traceDiv = document.getElementById('Trace');
	traceDiv2 = document.getElementById('Trace2');
});
function trace(){	
	if (pauseTracing == false) {
		let s ="";
		for (let i=0; i<arguments.length; i++)
			s += arguments[i];
		console.log(s);
		traceArray.push(s+"<br>");
		if (traceArray.length > maxTraces) traceArray.shift(0,1);
		if (traceDiv != null) {
			traceDiv.innerHTML = traceArray.join("");
			traceDiv.scrollTop = traceDiv.scrollHeight;
		}
	}
}
function tracef(){							// Same as trace but forces ouput always
	let s ="";
	for (let i=0; i<arguments.length; i++)
		s += arguments[i];
	console.log(s);
	traceArray.push(s+"<br>");
	if (traceArray.length > maxTraces) traceArray.shift(0,1);
	if (traceDiv != null) {
		traceDiv.innerHTML = traceArray.join("");
		traceDiv.scrollTop = traceDiv.scrollHeight;
	}
}
function trace2(){	
	if (pauseTracing == false) {
		let s ="";
		for (let i=0; i<arguments.length; i++)
			s += arguments[i];
		console.log(s);
		traceArray2.push(s+"<br>");
		if (traceArray2.length > maxTraces) traceArray2.shift(0,1);
		if (traceDiv2 != null) {
			traceDiv2.innerHTML = traceArray2.join("");
			traceDiv2.scrollTop = traceDiv2.scrollHeight;
		}
	}
}

