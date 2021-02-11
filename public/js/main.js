// Voicevault client
//
// Mark Gemmell Feb 2021
//

const SampleRate = 32000; 						// Global sample rate used for all audio
const PacketSize = 1000;						// Server packet size we must conform to
const HighFilterFreq = SampleRate/2.2;					// Mic filter to remove high frequencies before resampling
const LowFilterFreq = 30;						// Mic filter to remove low frequencies before resampling
const ChunkSize = 4096;							// Audio chunk size. Fixed by js script processor
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
	gain	: 0,
	gainRate: 100,
	targetGain: 1,
	ceiling : 1,
	agc	: true,
	peak	: 0,
};
var smooth = [];							// Pre-populated array of values for smooth overflow/shortage transations
for (let i=0; i<400; i++)
	smooth[i] = Math.cos(i/400*Math.PI)/2 + 0.5;


// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {				// New connection coming in
	trace('socket connected!');
	let urlParams = new URLSearchParams(window.location.search);	
	myID = urlParams.get('id');					// Get our ID from the URL
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

socketIO.on('disconnect', function () {
	trace('socket disconnected!');
	socketConnected = false;
});





// Media management and display code (audio in and out)
//
document.addEventListener('DOMContentLoaded', function(event){		// Add dynamic behaviour to UI elements
	tracef("Starting V1.0");
});

function setStatusLED(name, level) {					// Set the status LED's colour
	let LED = document.getElementById(name);
	if (level == "Red") LED.className="redLED";
	else if (level == "Orange") LED.className="orangeLED";
	else LED.className="greenLED";
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

	// 1. Get Mic audio, buffer it, and send it to server if enough buffered
	if (socketConnected) {						// Need connection to send
		micBuffer.push(...inData);				// Buffer mic audio
		while (micBuffer.length > micPacketSize) {		// While enough audio in buffer 
			let audio = micBuffer.splice(0, micPacketSize);	// Get a packet of audio
			let peak = 0;					// Note: no need for perf to set peak
			audio = reSample(audio, downCache, PacketSize);	
			let obj = applyAutoGain(audio, micIn);		// Amplify mic with auto limiter
			if (obj.peak > micIn.peak) 
				micIn.peak = obj.peak;			// Note peak for local display
			micIn.gain = obj.finalGain;			// Store gain for next loop
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
	let outAudio = [];
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
			let shortfall = ChunkSize-spkrBuffer.length;
			let rem = [];
			rem = spkrBuffer.splice(0,spkrBuffer.length);	// Take all audio that remains and fade down
			let t = (rem.length < 400)? 			// Transition to zero is as long as remaining audio
				rem.length : 400;			// up to a maximum of 400 samples
			for (let i=0; i<t; i++) {			// Smoothly drop to zero to reduce harsh clicks
				outAudio[i] = rem[i]*smooth[Math.round(i*400/t)];
			}
			smoothingNeeded = true;
			let zeros = new Array(shortfall).fill(0);	// Fill shortfall in audio with silence
			outAudio.push(...zeros);
		}
	} else shortages++;						// Not enough audio so add to shortages
	if (outAudio.length > 0)					// If there is audio to output
		for (let i in outData) { 
			outData[i] = outAudio[i];			// Copy audio to output 
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
	// Buttons used for testing...
	let testBtn=document.getElementById('testBtn');
	testBtn.onclick = function () {
		trace2("Echo Test Button Pressed");
		startEchoTest();
	};
	let actionBtn=document.getElementById('actionBtn');
	actionBtn.onclick = function () {
		trace("Pause traces pressed");
		if (pauseTracing == true) pauseTracing = false;
		else pauseTracing = true;
	};
});
var pauseTracing = false;						// Traces are on by default

// Reporting code. Accumulators, interval timer and report generator
//
var packetsIn = 0;
var packetsOut = 0;
var overflows = 0;
var shortages = 0;
function everySecond() {
	let netState = "stable";
	let generalStatus = "Green";
	if ((overflows > 1) || (shortages >1) || (netState != "stable")) generalStatus = "Orange";
	if (socketConnected == false) generalStatus = "Red";
	setStatusLED("GeneralStatus",generalStatus);
	let upperLimit = SampleRate/PacketSize * 1.2;
	let lowerLimit = SampleRate/PacketSize * 0.8;
	let upStatus = "Green";
	if ((packetsOut < lowerLimit) || (packetsOut > upperLimit)) upStatus = "Orange";
	if (packetsOut < lowerLimit/3) upStatus = "Red";
	setStatusLED("UpStatus",upStatus);
	let downStatus = "Green";
	if ((packetsIn < lowerLimit) || (packetsIn > upperLimit)) downStatus = "Orange";
	if (packetsIn < lowerLimit/3) downStatus = "Red";
	setStatusLED("DownStatus",downStatus);
	trace("In=",packetsIn," Out=", packetsOut," Ov=", overflows," Sh=", shortages);
	packetsIn = 0;
	packetsOut = 0;
	overflows = 0;
	shortages = 0;
}
setInterval(everySecond, 1000);						// Call report generator and slow UI updater once a second


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

