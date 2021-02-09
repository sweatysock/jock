//Global variables
//
const SampleRate = 16000; 						// Global sample rate used for all audio
const PerfSampleRate = 32000; 						// Target sample rate used for performer audio adjusted for BW
const PacketSize = 500;							// Server packet size we must conform to
const PerfPacketSize = PacketSize * PerfSampleRate/SampleRate;		// Figure the Performer packet size now. Handy to have.
const HighFilterFreq = SampleRate/2.2;					// Mic filter to remove high frequencies before resampling
const LowFilterFreq = 200;						// Mic filter to remove low frequencies before resampling
const ChunkSize = 4096;							// Audio chunk size. Fixed by js script processor
var soundcardSampleRate = null; 					// Get this from context 
var micAudioPacketSize = 0;						// Calculate this once we have soundcard sample rate
var adjMicPacketSize = 0;						// We adjust amount of data into and out of packets to optimize flow
var socketConnected = false; 						// True when socket is up
var micAccessAllowed = false; 						// Need to get user permission
var packetBuf = [];							// Buffer of packets sent, subtracted from venue mix later
var spkrBufferL = []; 							// Audio buffer going to speaker (left)
var spkrBufferR = []; 							// (right)
var smoothingNeeded = false;						// Flag to indicate if output smoothing needed after a shortage
var venueBuffer = []; 							// Buffer for venue audio
var smoothingNeededV = false;						// Flag to indicate if venue output smoothing needed after a shortage
var maxBuffSize = 20000;						// Max audio buffer chunks for playback. 
var micBufferL = [];							// Buffer mic audio before sending
var micBufferR = [];							
var noiseThreshold = 0.02;						// Default value for centrally controlled noise floor used to reduce noise if needed
var myNoiseFloor = 0.02;						// Locally calculated noise level derived from moments of venue and user silence
var myChannel = -1;							// The server assigns us an audio channel
var myName = "";							// Name assigned to my audio channel
var MaxNameLength = 15;							// User name max length
var myGroup = "noGroup";						// Group user belongs to. Default is no group.
var groupLayout = [8,12,4,10,6,9,7,11,5,13,3,14,2,15,1,16,0,4,10,6,9];	// Locations in circle ordered by group position. Last 4 get overlaid on others
var pans = [-9,-5,-3,-2.4,-2,-1.7,-1.4,-1.2,1,1.2,1.4,1.7,2,2.4,3,5,9];	// pan settings for each location on circle
var chatAdj = [0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80];	// chat bubble lateral adjustments for each location on circle
var groupCentre = 8;							// In the circle position 8 is right in front of us
var maxGroupSize = 17;							// Up to 17 can be positioned in a circle. More have to overlap.
var myPos = 0;
var performer = false;							// Indicates if we are the performer
var loopback = false;							// If we connect to a loopback server this will be true
var stereoOn = true;							// Default stereo audio setting
var HQOn = true;							// Default HQ audio setting
const NumberOfChannels = 20;						// Max number of channels in this server
var channels = [];							// Each channel's data & buffer held here
for (let i=0; i < NumberOfChannels; i++) {				// Create all the channels pre-initialized
	channels[i] = {
		name	: "",						// Each client names their channel
		gain 	: 1,						// Gain level for the channel
		agc	: true,						// Flag if control is manual or auto
		muted	: false,					// Local mute
		peak	: 0,						// Animated peak channel audio level 
		channel	: i,						// The channel needs to know it's number for UI referencing
		seq	:0,						// Track channel sequence numbers to monitor quality
		buffer8	:[],						// A buffer used to delay one of the channels for stereo placement
		buffer16:[],						// Need one for each sample class
	};
}
var liveShow = false;							// If there is a live show underway 
var serverLiveChannels = [];						// Server will keep us updated on its live channels here
var mixOut = {								// Similar structures for the mix output
	name 	: "Output",
	gain	: 0,
	gainRate: 100,
	targetGain: 1,
	ceiling : 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "mixOut",
};
var micIn = {								// and for microphone input
	name 	: "Mic",
	gain	: 0,
	gainRate: 100,
	targetGain: 1,
	ceiling : 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "micIn",
	threshold:0,							// Start with mic blocked so that initially no audio gets through until analysis complete
	gate	: 0,							// Threshold gate. >0 means open.
};
var venue = {								// Similar structure for the venue channel
	name 	: "Venue",
	gain	: 0,
	gainRate: 50,
	targetGain: 1,
	ceiling : 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "venue",
};
var blocked = 0;							// Counter used to block mic input to avoid feedback cutting output
var goodCount = 0;							// Counter used to decide echo is no longer a risk
var recording = false;							// Used for testing purposes
var serverMuted = false;
var venueSize = 1;							// Number of people in the venue. Used for adjusting venue audio.
var venueSizeCmd = 0;							// Size of venue sent through command channel from event manager
var audience = 1;							// Number of clients in this venue as reported to us by server
var rtt = 0;								// Round Trip Time used to adjust sample rate to avoid logjamming
var rtt1 = 0;								// 1 second average rtt
var rtt5 = 0;								// 5 second average rtt. These need to be similar for stability
var smooth = [];							// Pre-populated array of values for smooth overflow/shortage transations
for (let i=0; i<400; i++)
	smooth[i] = Math.cos(i/400*Math.PI)/2 + 0.5;
var chatText = "";							// Text input by user to send to server
var bubbleArea;								// Object where chat bubbles appear
var chatHistory;							// div where a full hisory of the group chat is held

function processCommands(newCommands) {					// Apply commands sent from upstream servers
	if (newCommands.mute != undefined) serverMuted = newCommands.mute; else serverMuted = false;
	if (newCommands.gateDelay != undefined) gateDelay = newCommands.gateDelay * peakWindow/ChunkSize;;
	if (newCommands.venueSize != undefined) venueSizeCmd = newCommands.venueSize;
	if (newCommands.perfLevel != undefined) if (performer) {micIn.gain = newCommands.perfLevel; micIn.agc = false;}
	if (newCommands.noiseThreshold != undefined) noiseThreshold = newCommands.noiseThreshold;
	if (newCommands.displayURL != undefined);
	if (newCommands.displayText != undefined);
}

// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {				// New connection coming in
	trace('socket connected!');
	let urlParams = new URLSearchParams(window.location.search);	
	let key = urlParams.get('key');					// Get the key from the URL
	if (key == null)  						// If it isn't there then go to the error page
		window.location.href = "https://audence.com/error-serveraccess";
	socketIO.emit("upstreamHi",{channel:myChannel,key:key});	// Register with server and request channel, supplying the key given
});

socketIO.on('channel', function (data) {				// Message assigning us a channel
	if (data.channel > 0) {						// Assignment successful
		myChannel = data.channel;
		if (myName == "") myName = "Input " + myChannel;	// Name my channel if empty
		micIn.name = "Mic ("+ myChannel +")";			// Indicate channel in Mic name
		let id = document.getElementById("ID"+micIn.channel+"Name")
		if (id != null) id.innerHTML = micIn.name;		// Update onscreen name if created
		trace('Channel assigned: ',myChannel);
		socketConnected = true;					// The socket can be used once we have a channel
		pitch = 0;						// Pitch adjustment resets now
		if (data.loopback) {					// We have connected to a lopback server
			loopback = true;				// Flag we are in loopback mode to enable self-monitoring
			performer = true;				// Go into performer mode
			document.getElementById("onair").style.visibility = "visible";
			micFilter1.frequency.value = PerfSampleRate/2.2;	
			micFilter2.frequency.value = 30;
		} else							// if not in loopback mode
			loadVenueReverb(data.reverb);			// load the venue reverb file to give ambience
		myGroup = data.defGroup;				// The server will tell us our default group
		if (myGroup != "noGroup") {
			let groupNameEntry = document.getElementById('groupNameEntry');
			if (groupNameEntry != null)
				groupNameEntry.innerHTML = myGroup;	// Update the group name on screen
		}
	} else {
		trace("Server unable to assign a channel");		// Server is probaby full
		trace("Try a different server");			// Can't do anything more
		socketConnected = false;
	}
});

socketIO.on('perf', function (data) {					// Performer status notification
	performer = data.live;
	if (performer == true) {
		document.getElementById("onair").style.visibility = "visible";
		micFilter1.frequency.value = PerfSampleRate/2.2;	// Change mic filter for performance audio
		micFilter2.frequency.value = 30;
	} else {
		document.getElementById("onair").style.visibility = "hidden";
		micFilter1.frequency.value = HighFilterFreq		// Return mic filter to normal settings
		micFilter2.frequency.value = LowFilterFreq;
	}
});

// Data coming down from upstream server: Group mix plus separate member audios
socketIO.on('d', function (data) { 
	enterState( dataInState );					// This is one of our key tasks
	packetsIn++;							// For monitoring and statistics
	let len=JSON.stringify(data).length/1024;			// Get actual packet size received before any changes
	bytesRcvd += len;						// Accumulate in incoming data total count
	serverLiveChannels = data.liveChannels;				// Server live channels are for UI updating
	processCommands(data.commands);					// Process commands from server
	if (!micAccessAllowed) {					// Need access to audio before outputting
		enterState( idleState );				// Back to Idling
		return;							// No audio access so do nothing with incoming data
	}
	let v = new Array(adjMicPacketSize).fill(0);			// Our objective is to get the venue audio (if any) in here,
	let c8 = new Array(PacketSize/2).fill(0);			// Buffer of group audio to be subtracted from the venue audio 
	let c16 = new Array(PacketSize/2).fill(0);			// in MSRE format
	let gL = [], gR = [];						// the group stereo audio (if any) in here
	let pL = [], pR = [];						// and the performer stereo audio (if any) in here. Then mix and send to speaker
	let isStereo = false;						// flag to indicate if we have stereo audio
	// 1. Build a mix of all group channels. For individuals or empty groups no audio will have been sent
	let L8 = new Array(PacketSize/2).fill(0);			// Temp arrays for MSRE blocks for left channel
	let L16 = new Array(PacketSize/2).fill(0);			// so that we only do one MSRE decode at the end
	let R8 = new Array(PacketSize/2).fill(0);			// Temp arrays for MSRE blocks for right channel
	let R16 = new Array(PacketSize/2).fill(0);		
	let someAudio = false;						// If no audio this saves us checking
	let myPosition = serverLiveChannels[myChannel];			// Obtain my position in the group
	let myLoc = groupLayout[myPosition];				// Find the location in the cicle that corresponds to my position
	let shift = groupCentre - myLoc;				// Find how much everyone has to move to put me in the centre
	data.channels.forEach(c => {					// Process all audio channel packets including channel 0
		let ch = c.channel;					// Channel number the packet belongs to
		let chan = channels[ch];				// Local data structure for this channel
		chan.name = c.name;					// Update local structure's channel name
		chan.channel = ch;					// Keep channel number too. It helps speed lookups
		let p = serverLiveChannels[ch];				// Get channel's position in the group
		let l = groupLayout[p];					// Get circle location for this group position
		l = (l + shift) % maxGroupSize;				// Move the position to put me at the centre
		let att = pans[l];					// find the panning position for this location
		if (c.chatText != "") 					// If there is some chatText from this channel display it
			chatMessage(c.name, c.chatText, l);
		if ((c.socketID != socketIO.id) && (ch != 0)) {		// Don't include my audio or channel 0 in the group mix
			if (chan.peak < c.peak)				// set the peak for this channel's level display
				chan.peak = c.peak;			// even if muted
			let a = c.audio;				// Get the audio from the packet
			let m8 = a.mono8;
			let m16 = a.mono16;
			let b8 = chan.buffer8;				// Channel delay buffers where delayed audio is held
			let b16 = chan.buffer16;
			let g = (chan.agc 				// Apply gain. If AGC use mix gain, else channel gain
				? mixOut.gain : chan.gain);	
			chan.gain = g;					// Channel gain level should reflect gain applied here
			g = chan.muted ? 0 : g;				// If channel is muted, silence it's output but still cancel it in venue mix
			if (m8.length > 0) {				// Only mix if there is audio in channel
				someAudio = true;			// Flag that there is actually some group audio
				let al = 0, ar = 0;			// Attenuations for each channel. Default is none
				if (att < 0) {				// Applying attenuation to right channel
					ar = att * -1;			// Invert attenuation 
					for (let i=0; i < m8.length; i++) {L8[i] += m8[i] *g; c8[i] += m8[i]; R8[i] += m8[i]*g/ar;}
				} else {				// Applying attenuation to left channel
					al = att;		
					for (let i=0; i < m8.length; i++) {R8[i] += m8[i] *g; c8[i] += m8[i]; L8[i] += m8[i]*g/al;}
				}			
			}					
			if (m16.length > 0) {				// If there is high frequency content mix it too
				let al = 0, ar = 0;
				if (att < 0) {				// Applying attenuation to right channel
					ar = att * -1;			// Invert attenuation
					for (let i=0; i < m16.length; i++) {L16[i] += m16[i] *g; c16[i] += m16[i]; R16[i] += m16[i]*g/ar;}
				} else {				// Applying attenuation to left channel
					al = att;
					for (let i=0; i < m16.length; i++) {R16[i] += m16[i] *g; c16[i] += m16[i]; L16[i] += m16[i]*g/al;}
				}			
			}
		}
		if (c.sequence != (chan.seq + 1)) 			// Monitor audio transfer quality for all channels
			trace("Sequence jump Channel ",ch," jump ",(c.sequence - chan.seq));
		chan.seq = c.sequence;					// Store seq number for next time a packet comes in
	});
	if (someAudio) {						// If there is group audio rebuild and upsample it
		let k = 0;
		for (let i=0;i<L8.length;i++) {				// Reconstruct stereo group mix from the MSRE blocks
			gL[k] = L8[i] + L16[i];
			gR[k] = R8[i] + R16[i];k++;
			gL[k] = L8[i] - L16[i];
			gR[k] = R8[i] - R16[i];k++;
		}							// Bring sample rate up to HW sample rate
		gL = reSample(gL, gLCache, adjMicPacketSize); 
		gR = reSample(gR, gRCache, adjMicPacketSize); 
		isStereo = true;
	} 
	let mixL = [], mixR = [];
	if (gL.length > 0) {mixL = gL; mixR = gR;}			// Put group audio in the mix if any
	else {								// If no group mix then fill mix with 0's
		let s = adjMicPacketSize;				// This is the size of the input/output packet size
		mixL = new Array(s).fill(0), mixR = new Array(s).fill(0);
	}
	// 2. Process venue mix from server 
	let ts = 0;
	let vData = data.venue;
	if (vData != null) {						// If there is venue data find our seq #, subtract it, & correct venue level
		ts = vData.timestamps[myChannel];			// Venue data also contains timestamps that allow rtt measurement
		audience = vData.liveClients;				// The server sends us the current audience count for level setting
		if (venueSizeCmd == 0) venueSize = audience;		// If there is no command setting the venue size we use the audience size
		else venueSize = venueSizeCmd;				// otherwise the command sets the audience size = attenuation level
		let a8 = [], a16 = [];					// Temp store for our audio for subtracting (echo cancelling)
		let s = vData.seqNos[myChannel];			// If the venue mix contains our audio this will be its sequence no.
		if (s != null) {					// If we are performer or there are network issues our audio won't be in the mix
			while (packetBuf.length) {			// Scan the packet buffer for the packet with this sequence
				let p = packetBuf.shift();		// Remove the oldest packet from the buffer until s is found
				if (p.sequence == s) {			// We have found the right sequence number
					a8 = p.audio.mono8;		// Get our MSRE blocks from packet buffer
					a16 = p.audio.mono16;	
					break;				// Packet found so stop scanning the packet buffer. 
				}
			}
		}
		let audio = zipson.parse(vData.audio);			// Uncompress venue audio
		let v8 = audio.mono8, v16 = audio.mono16;		// Shortcuts to the venue MSRE data blocks
		if ((v8.length > 0) && (!venue.muted)) {		// If there is venue audio & not muted, it will need processing
			let vTemp = [];					// Temp store of venue audio
			let sr = 8000;					// Minimum sample rate of 8kHz
			let gn = venue.gain / venueSize;		// Gain adjusts for fader setting and venue size most importantly
			if ((a8.length > 0) && (c8.length > 0))		// If we have audio and group has audio remove both and set venue level
				for (let i = 0; i < a8.length; ++i) v8[i] = (v8[i] - a8[i] -c8[i]);
			if ((a8.length > 0) && (c8.length == 0))	// If there is only our audio subtract it and set venue level
				for (let i = 0; i < a8.length; ++i) v8[i] = (v8[i] - a8[i]);
			if ((a8.length == 0) && (c8.length > 0))	// If there is only group cancelling audio subtract it and set venue level
				for (let i = 0; i < c8.length; ++i) v8[i] = (v8[i] - c8[i]);
			if (v16.length > 0) {				// If the venue has higher quality audio repeat the same process
				if ((a16.length > 0) && (c16.length > 0))
					for (let i = 0; i < a16.length; ++i) v16[i] = (v16[i] - a16[i] -c16[i]);
				if ((a16.length > 0) && (c16.length == 0))
					for (let i = 0; i < a16.length; ++i) v16[i] = (v16[i] - a16[i]);
				if ((a16.length == 0) && (c16.length > 0))
					for (let i = 0; i < c16.length; ++i) v16[i] = (v16[i] - c16[i]);
				let k = 0;				// reconstruct the original venue audio in v[]
				for (let i=0;i<v8.length;i++) {	
					vTemp[k] = v8[i] + v16[i];k++;
					vTemp[k] = v8[i] - v16[i];k++;
				}
				sr = 16000;				// This is at the higher sample rate
			} else vTemp = v8;					// Only low bandwidth venue audio 
			let obj = applyAutoGain(vTemp, venue);		// Amplify venue with auto limiter
			venue.gain = obj.finalGain;			// Store gain for next time round
			if (obj.peak > venue.peak) venue.peak = obj.peak;
			v = reSample(vTemp, vCache, adjMicPacketSize); 
		}
	} 
	// 3. Process performer audio if there is any, and add it to the mix. This could be stereo audio
	performer = (data.perf.chan == myChannel);			// Update performer flag just in case
	liveShow = data.perf.live;					// Update the live show flag to update display
	if ((data.perf.live) && (data.perf.packet != null)		// If there is a live performer with data
		&& (data.perf.packet.perfAudio != false)) {		// and audio then process it and audio then process it
		let audio = zipson.parse(data.perf.packet.perfAudio);	// Uncompress performer audio
		let m8 = audio.mono8;
		let m16 = audio.mono16;
		let m32 = audio.mono32;
		if ((!performer) || (loopback)) {			// If we are not the performer or we are in loopback play perf audio
			let mono = [];					// Reconstruct performer mono audio into this array
			let stereo = [];				// Reconstruct performer stereo difference signal into here
			let j = 0, k = 0;
			let sr = 32000;					// Sample rate can vary but it will break this code!
			if (m8.length == 0) {				// For some reason there is no audio
				let mono = new Array(250).fill(0);	// so generate silence
				sr = 8000;				// Set the sample rate and we're done
			} else if (m16.length == 0) {			// There is only 8kHz perf audio coming from server
				mono = m8;				// so just pass these 250 bytes through
				sr = 8000; 			
			} else if (m32.length == 0) {			// Standard quality audio 16kHz 500 bytes
				for (let i=0;i<m8.length;i++) {		// Reconstruct the 500 byte packet
					mono[k] = m8[i] + m16[i];k++;
					mono[k] = m8[i] - m16[i];k++;
				}
				sr = 16000; 
			} else for (let i=0; i<m8.length; i++) {	// Best rate. 32kHz. Rebuild the 1k packet
				let s = m8[i] + m16[i];
				let d = m8[i] - m16[i];
				mono[k] = s + m32[j]; k++;
				mono[k] = s - m32[j]; j++; k++;
				mono[k] = d + m32[j]; k++;
				mono[k] = d - m32[j]; j++; k++;
			}						// Mono perf audio ready to upsample
			mono = reSample(mono, upCachePerfM, adjMicPacketSize);
			let s8 = audio.stereo8;// Now regenerate the stereo difference signal
			let s16 = audio.stereo16;
			let s32 = audio.stereo32;
			if (s8.length > 0) {				// Is there a stereo signal in the packet?
				isStereo = true;
				j = 0, k = 0;
				if (s16.length == 0) {			// Low quaity stereo signal
					stereo = s8;
					sr = 8000;
				} else if (s32.length == 0) {		// Mid quality stereo signal
					for (let i=0;i<s8.length;i++) {	
						stereo[k] = s8[i] + s16[i];k++;
						stereo[k] = s8[i] - s16[i];k++;
					}
					sr = 16000; 
				} else for (let i=0; i<s8.length; i++) {
					let s = s8[i] + s16[i];		// Best stereo signal. Rebuild the 1k packet
					let d = s8[i] - s16[i];
					stereo[k] = s + s32[j]; k++;
					stereo[k] = s - s32[j]; j++; k++;
					stereo[k] = d + s32[j]; k++;
					stereo[k] = d - s32[j]; j++; k++;
				}					// Stereo difference perf audio upsampling now
				stereo = reSample(stereo, upCachePerfS, adjMicPacketSize);
				let left = [], right = [];		// Time to reconstruct the original left and right audio
				for (let i=0; i<mono.length; i++) {	// Note. Doing this after upsampling because mono
					left[i] = (mono[i] + stereo[i])/2;	// and stereo may not have same sample rate
					right[i] = (mono[i] - stereo[i])/2;	// Divide by 2 because output is double input
				}
				if (mixL.length == 0) {			// If no group audio just use perf audio directly
					mixL = left; mixR = right;
				} else {				// Have to build stereo mix
					for (let i=0; i < left.length; i++) {
						mixL[i] += left[i];	
						mixR[i] += right[i];
					}
				}
			} else { 					// Just mono performer audio
				if (mixL.length == 0) {			// If no group audio just use perf audio directly
					mixL = mono; 
					mixR = mono; 
				} else {				// Have to build stereo mix with mono perf and potentially stereo group
					isStereo = true;
					for (let i=0; i < mono.length; i++) {
						mixL[i] += mono[i];	
						mixR[i] += mono[i];
					}
				}
			}
		} else ts = data.perf.packet.timestamp;			// I am the performer so grab timestamp for the rtt 
		if (loopback) ts = data.perf.packet.timestamp;		// In loopback mode we output perf audio but we still need the rtt

		let p = data.perf.packet;				// If the performer was in our group and is chatting
		if ((myGroup != "noGroup") && (p.group == myGroup) && (p.chatText != "")) {
			let ch = p.channel;				// Channel number the perf if using
			let pos = serverLiveChannels[ch];		// Get perf's position in the group
			let l = groupLayout[pos];			// Get circle location for this group position
			let myP = serverLiveChannels[myChannel];	// Obtain my position in the group
			let myLoc = groupLayout[myP];			// Find the location in the circle that corresponds to my position
			let shift = groupCentre - myLoc;		// Find how much everyone has to move to put me in the centre
			l = (l + shift) % maxGroupSize;			// Move the position to put me at the centre
			chatMessage(p.name, p.chatText, l);		// Display the perf's chat message
		}
	} 
	// 4. Adjust gain of final mix containing performer and group audio, and send to the speaker buffer
	let obj;						
	if (isStereo) {
		let peakL = maxValue(mixL);				// Set gain according to loudest channel
		let peakR = maxValue(mixR);
		if (peakL > peakR) {
			obj = applyAutoGain(mixL, mixOut);		// Left sets the gain
			applyGain(mixR, obj.finalGain);			// and right follows
		} else {
			obj = applyAutoGain(mixR, mixOut);		// Right sets the gain
			applyGain(mixL, obj.finalGain);			// and left follows
		}
	} else obj = applyAutoGain(mixL, mixOut);			// For mono just use left channel
	mixOut.gain= obj.finalGain;					// Store gain for next loop
	obj.peak += venue.peak;						// Display the venue level mixed with the main output
	if (obj.peak > mixOut.peak) mixOut.peak = obj.peak;		// Note peak for display purposes
	if (spkrBufferL.length < spkrBuffTrough) 			// Monitoring purposes
		spkrBuffTrough = spkrBufferL.length;
	spkrBufferL.push(...mixL);					// put left mix in the left speaker buffer
	if (isStereo)
		spkrBufferR.push(...mixR);				// and the right in the right if stereo
	else
		spkrBufferR.push(...mixL);				// otherwise use the left
	if (spkrBufferL.length > maxBuffSize) {				// If too full merge final 400 samples
//		for (let i=0; i<400; i++) {				// so that we end with the latest waveform
//			let p = maxBuffSize-i-1;			// Points to end of audio being kept
//			let q = spkrBufferL.length-i-1;			// Points to end of audio being trimmed
//			let f = smooth[i];				// Transition blending factor. From 1 to 0 for INCREASING i
//			spkrBufferL[p] = spkrBufferL[p]*(1-f) + spkrBufferL[q]*f;
//			spkrBufferR[p] = spkrBufferR[p]*(1-f) + spkrBufferR[q]*f;
//		}
		let excess = spkrBufferL.length-maxBuffSize;
		spkrBufferL.splice(maxBuffSize/2,maxBuffSize/2);	// Chop buffer in half
		spkrBufferR.splice(maxBuffSize/2,maxBuffSize/2);	// Chop buffer in half
//		spkrBufferL.splice(0, excess); 	
//		spkrBufferR.splice(0, excess); 	
		overflows++;						// Note for monitoring purposes
		if (pitch > (-1 * pitchLimit)) pitch--;			// Decrease amount of data from each packet to reduce overflows
		bytesOver += excess;
	}
	if (spkrBufferL.length > spkrBuffPeak) 				// Monitoring purposes
		spkrBuffPeak = spkrBufferL.length;
	if (v.length > 0) {						// Add the venue audio to its own buffer
		venueBuffer.push(...v);					// Add any venue audio to the venue buffer
	}
	if (venueBuffer.length > maxBuffSize) {				// Clip buffer if too full
		venueBuffer.splice(maxBuffSize/2, maxBuffSize/2); 	
		overflows++;						// Note for monitoring purposes
		if (pitch > (-1 * pitchLimit)) pitch--;			// Decrease amount of data from each packet to reduce overflows
	}
	// 5. Calculate RTT 
	if (ts > 0) {							// If we have timestamp data calcuate rtt
		let now = new Date().getTime();
		rtt = now - ts;						// Measure round trip time using a rolling average
		if (rtt1 == 0) rtt1 = rtt;
		else rtt1 = (9 * rtt1 + rtt)/10;
		rtt5 = (49 * rtt5 + rtt)/50;
	}
	enterState( idleState );					// Back to Idling
});

socketIO.on('disconnect', function () {
	trace('socket disconnected!');
	socketConnected = false;
	pitch = 0;							// reset pitch adjustment as connection is reseting
});





// Media management and display code (audio in and out)
//
var displayRefresh = 100;						// mS between UI updates. MARK change to animation frame
document.addEventListener('DOMContentLoaded', function(event){		// Add dynamic behaviour to UI elements
	tracef("Starting V1.0");
	let groupBtn = document.getElementById('groupBtn');		// Button that activates group name entry field
	let groupNameEntry = document.getElementById('groupNameEntry');	// Group name entry field iself
	let nickEntry = document.getElementById('nickname');		// User's screen name display on their audio channel and chat messages
	let inputText = document.getElementById('inputText');		// Chat text input area
	let chatWin = document.getElementById('chatWin');		// The div that contains the chat history window. Not sure why 2 divs!
	let nameBadge = document.getElementById('nameBadge');		// Div that contains the nickname entry field. Don't need two divs either!
	let chatInput = document.getElementById('chatInput');		// Div containing the input text. 2 divs not needed here either.
	bubbleArea = document.getElementById('chatBubbleArea');		// Div where chat bubbles are animated
	chatHistory = document.getElementById('chatHistory');		// The chat history window itself. Again, 2 divs not needed.
	groupBtn.onclick = ( (e) => {
		groupNameEntry.style.visibility = "visible";		// Make the group entry field visible
		helpp.style.visibility = "hidden";			// Hide the help window 
		if (myGroup == "noGroup") {				// Group entry. By default we are in "noGroup". This displays as ""
			groupNameEntry.value = "";
			groupNameEntry.focus();				// Enter group name first
		} else {
			groupNameEntry.value = myGroup;
			nameBadge.style.visibility = "visible";
			nickEntry.focus();				// We have a group name so go to user name
			chatInput.style.visibility = "visible";
		}
	});
	groupNameEntry.setAttribute("maxlength",30);			// Set group name length limit to 30
	groupNameEntry.addEventListener("keydown", (e) => {		// Filter key presses directly
		if (e.which === 32) e.preventDefault();			// No spaces allowed in group name
		if (e.which === 13) {					// Enter is captured and processed in js
			if (groupNameEntry.value=="") {			// An empty group name means "noGroup" - hide all group UI
				myGroup = "noGroup";
				nameBadge.style.visibility = "hidden";
				chatInput.style.visibility = "hidden";
				chatWin.style.visibility = "hidden";	// Hide chat window (history window)
				bubbleArea.style.visibility = "hidden";	// and bubble area
				groupNameEntry.blur();			// and remove the focus from the group input field
			} else {
//				chatHistory.innerHTML += "<div style='color:#FFCC00'>Group changed from "+myGroup+" to "+groupNameEntry.value+"</div>";
//				chatHistory.scrollTop = chatHistory.scrollHeight;	
//				myGroup = groupNameEntry.value;		// group name is good. Make name and chat text area visible
				nameBadge.style.visibility = "visible";
				chatInput.style.visibility = "visible";
				chatWin.style.visibility = "hidden";	// Hide chat window (history window)
				bubbleArea.style.visibility = "visible";// and make the bubble area visible by default
				nickEntry.focus();			// put focus in name entry field
			}
			e.preventDefault();
		}
	});
	groupNameEntry.addEventListener("focusout", (e) => {		// If you tab or click out of the field the same needs to happen
		if (groupNameEntry.value=="") {				// User has opted for no group so hide all chat UI elements
			myGroup = "noGroup";
			nameBadge.style.visibility = "hidden";
			chatInput.style.visibility = "hidden";
			chatWin.style.visibility = "hidden";
			bubbleArea.style.visibility = "hidden";
			groupNameEntry.blur();
		} else {
			if (myGroup != groupNameEntry.value) {
				chatHistory.innerHTML += "<div style='color:#FFCC00'>Group changed from "+myGroup+" to "+groupNameEntry.value+"</div>";
				chatHistory.scrollTop = chatHistory.scrollHeight;	
			}
			myGroup = groupNameEntry.value;
			nameBadge.style.visibility = "visible";
			chatInput.style.visibility = "visible";
			chatWin.style.visibility = "hidden";		// Hide chat window (history window)
			bubbleArea.style.visibility = "visible";	// and make the bubble area visible by default
			nickEntry.focus();
		}
	});
	nickEntry.setAttribute("maxlength",MaxNameLength);		// Set nickname length limit 
	nickEntry.addEventListener("keydown", (e) => {
		if (e.which === 13) {
			inputText.focus();				// When enter is hit move focus to chat text entry 
			e.preventDefault();
		}
	});
	nickEntry.addEventListener("focusout", (e) => {			// By clicking, tabbing or hitting enter, focus is lost. Process the nickname
		if (nickEntry.value=="") {
			nickEntry.value = myName;			// If the name is empty use the old one
		} else if (nickEntry.value != myName) {			// If it has changed log it to the chat history
			chatHistory.innerHTML += "<div style='color:#FFCC00'>"+myName+" changed to "+nickEntry.value+"</div>";
			chatHistory.scrollTop = chatHistory.scrollHeight;	
			myName = nickEntry.value;
		}
		document.getElementById("IDmicInName").innerHTML = myName;	// Update the mixer UI with the new name
	});
	inputText.addEventListener("keydown", (e) => {
		if (e.which === 13) {					// When they hit enter in the chat text input
			chatText = inputText.value;			// store the text for sending to the server
			inputText.value = "";				// and empty the field
			e.preventDefault();
		}
	});
	let chatHistBtn = document.getElementById('chatHistBtn');	// The chat history button shows/hides the traditional chat window
	chatHistBtn.onclick = ( (e) => {
		if (chatWin.style.visibility == "hidden") {
			bubbleArea.style.visibility = "hidden";		// Chat bubbles are hidden if chat history is visible
			chatWin.style.visibility = "visible";
		} else {
			bubbleArea.style.visibility = "visible";
			chatWin.style.visibility = "hidden";
		}
	});
	let helpBtn = document.getElementById('helpBtn');		// Help button toggles the help window
	let helpp = document.getElementById('helpp');
	helpBtn.onclick = ( (e) => {
		if (helpp.style.visibility == "hidden")
			helpp.style.visibility = "visible";
		else
			helpp.style.visibility = "hidden";
	});
	let micMuted = document.getElementById('micMuted');
	let micOpen = document.getElementById('micOpen');
	micMuted.onclick = ( (e) => {
		let micOnMixer = document.getElementById('IDmicInOn');
		micIn.muted = false;
		micMuted.style.visibility = "hidden";
		micOpen.style.visibility = "visible";
		micOnMixer.style.visibility = "inherit";
		if (forcedMute) {					// If UI mute state was forced due to high threshold force mic open for 1 second
			micIn.gate = 2 * Math.round(soundcardSampleRate/ChunkSize);				
trace2("FORCE UNmute");
			forcedMute = false;				// Not strictly necessary, but as we are clearly unmuted may as well unforce too
		}
	});
	micOpen.onclick = ( (e) => {
		let micOnMixer = document.getElementById('IDmicInOn');
		micIn.muted = true;
		micMuted.style.visibility = "visible";
		micOpen.style.visibility = "hidden";
		micOnMixer.style.visibility = "hidden";
	});
	navigator.mediaDevices.addEventListener('devicechange', () => {	// List all input/output devices on device change
		// MARK CONSIDER REPEATING ECHO TEST HERE IF THIS TRIGGERS WITH HEADPHONES
		navigator.mediaDevices.enumerateDevices()		// Testing this to see if we can detect headphones reliably
		.then(devices => {
			tracef("device change: ",JSON.stringify(devices));  
		});
	});
		navigator.mediaDevices.enumerateDevices()		// List devices at start to help detect changes
		.then(devices => {
			tracef("devices: ",JSON.stringify(devices));  
		});
});

function chatMessage(name, text, loc) {					// Display chat message in multiple places for given name and location
	chatHistory.innerHTML += "<div><span style='color:#FFFFFF'>"+name+": </span>"+text+"</div>";
	chatHistory.scrollTop = chatHistory.scrollHeight;		// Use the global chatHistory 
	let adj = chatAdj[loc];						// Get the lateral adjustment that corresponds to this location
	let div = document.createElement("div");			// Create a new div for the chat bubble
	div.style.left = adj+"%";					// Adjust it's position in the column
	div.classList.add("chatBubble");				// Set the class and add the contents to display
	div.innerHTML = "<span style='color:#FFFFFF'>"+name+": </span>"+text+"</div>";
	setTimeout(function () {div.parentNode.removeChild(div)},15000);
	bubbleArea.appendChild(div);					// Use the global bubbleArea

}

function displayAnimation() { 						// called 100mS to animate audio displays
	enterState( UIState );						// Measure time spent updating UI
	const rate = 0.8;						// Speed of peak drop in LED level display
	if (micAccessAllowed) {						// Once we have audio we can animate audio UI
		mixOut.peak = mixOut.peak * rate; 			// drop mix peak level a little for smooth drops
		setLevelDisplay( mixOut );				// Update LED display for mix.peak
		setSliderPos( mixOut );					// Update slider position for mix gain
		micIn.peak = micIn.peak * rate; 			// drop mic peak level a little for smooth drops
		setLevelDisplay( micIn );				// Update LED display for mic.peak
		setSliderPos( micIn );					// Update slider position for mic gain
		if (!loopback) setThresholdPos( micIn );		// In loopback the threshold display is not needed
		venue.peak = venue.peak * rate; 			// drop venue peak level a little for smooth drops
		setLevelDisplay( venue );				// Update LED display for venue.peak
		setSliderPos( venue );					// Update slider position for venue gain
		for (let ch in channels) {				// Update dynamic channel's UI
			c = channels[ch];
			if ((c.name != "") && 				// A channel needs a name to be active
				(c.channel != myChannel)) {		// and I don't want my channel to appear
				if (serverLiveChannels[ch] == null)	// Channel must have disconnected. 
					removeChannelUI(c);		// Remove its UI presence
				else {
					if (c.displayID == undefined)	// If there is no display associated to the channel
						createChannelUI(c);	// build the visuals 
					c.peak = c.peak * rate;		// drop smoothly the max level for the channel
					setLevelDisplay( c );		// update LED display for channel peak
					setSliderPos( c );		// update slider position for channel gain
					let id = "ID"+c.channel+"Name";	// Get the id used for the channel UI name element
					let n = document.getElementById(id);
					n.innerHTML = c.name;		// Update the channel display name
				}
			}
		}
	}
	if (displayRefresh <= 1000)					// If CPU really struggling stop animating UI completely
		setTimeout(displayAnimation, displayRefresh);		// Call animated display again. 
	enterState( idleState );					// Back to Idling
}

var forcedMute = false;							// Flag used to avoid unecessary work. Detect changes in state.
function updateUIMute() {						// Set UI mute appearance according to mic threshold if appropriate
	if ((echoRisk) && (!micIn.muted)) {				// If there is an echo risk and the mic has not been manually muted
		if ((forcedMute) && (micIn.threshold <= 1.0)) {		// If a forced mute state has been previously set, but is no longer necessary
			document.getElementById('IDmicInOn').style.visibility = "inherit";	// Un mute the UI
			document.getElementById('micMuted').style.visibility = "hidden";
			document.getElementById('micOpen').style.visibility = "visible";
			forcedMute = false;				// Flag that UI mute has been unforced
		} else if ((!forcedMute) && (micIn.threshold > 1.0)) {	// If we haven't already forced UI mute and the mic threshold has imposed muting
			document.getElementById('IDmicInOn').style.visibility = "hidden";		// Show the UI as muted
			document.getElementById('micMuted').style.visibility = "visible";
			document.getElementById('micOpen').style.visibility = "hidden";
			forcedMute = true;				// Flag that UI mute has been forced
		}
	}
}

function toggleSettings() {						// Hide/show settings = mixing desk
	let d = document.getElementById("mixerViewer");
	if (d.style.visibility == "hidden") {
		d.style.visibility = "visible";
		displayRefresh = 100;
		setTimeout(displayAnimation, displayRefresh);
	} else {
		d.style.visibility = "hidden";
		displayRefresh = 2000;
	}
}

function mapToLevelDisplay( n ) {					// map input to log scale in level display div
	let v = 0;
	if (n > 0.01) 
		v = (10.5 * Math.log10(n) + 21)*65/21;			// v=(10.5log(n)+21)65/21
	return v;
}

function setLevelDisplay( obj ) { 					// Set LED display level for obj
	let v = obj.peak;
	let h1, h2, h3;
	v = mapToLevelDisplay(v);
	if (v < 49.5) {h1 = v; h2 = 0; h3 = 0;} else
	if (v < 58.8) {h1 = 49.5; h2 = (v-49.5); h3 = 0;} else
			{h1 = 49.5; h2 = 9.3; h3 = (v-58.8);}
	let d = document.getElementById(obj.displayID+"LevelGreen");
	d.style.height = h1+"%";
	d = document.getElementById(obj.displayID+"LevelOrange");
	d.style.height = h2+"%";
	d = document.getElementById(obj.displayID+"LevelRed");
	d.style.height = h3+"%";
}

function setThresholdPos( obj ) {					// Set threshold indicator position
	let v = obj.threshold;
	if ((v > 0) && (v < 0.011)) v = 0.011;
	v =  mapToLevelDisplay(v);					// Modifying bottom edge so add 8
	let d = document.getElementById(obj.displayID+"Threshold");
	d.style.height = v+"%";
}

function setSliderPos( obj ) {
	let gain = obj.gain;						// With AGC slider shows actual gain, otherwise manual gain
	let pos;
	if (gain < 1) pos = (34 * gain) + 8; 
	else
		pos = (2.5 * gain) + 39.5;
	let sl = document.getElementById(obj.displayID + "Slider");
	sl.style.bottom = pos + "%" ;
}

function createChannelUI(obj) {						// build single channel UI with IDs using name requested
	let name = "ID"+obj.channel;
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:90%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<img style="position:absolute;right:30%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOff.png" id="'+name+'Off" onclick="unmuteButton(event)">  \
			<img style="position:absolute;right:30%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOn.png" id="'+name+'On" onclick="muteButton(event)">  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOff.png" id="'+name+'AGCOff" onclick="agcButton(event)">  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOn.png" id="'+name+'AGCOn" onclick="agcButton(event)">  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA; font-size: 3vmin" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.name+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function createOutputUI(obj) {						// UI for output channel
	let name = "ID"+obj.channel;
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:90%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<img style="position:absolute;right:14%; top:9.3%;width:72%; padding-bottom:10%;visibility: hidden" src="images/live.png" id="'+name+'live" >  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOff.png" id="'+name+'AGCOff" onclick="agcButton(event)">  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOn.png" id="'+name+'AGCOn" onclick="agcButton(event)">  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA;font-size: 3vmin" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.name+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function createMicUI(obj) {						// UI for mic input channel
	let name = "ID"+obj.channel;
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:90%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<img style="position:absolute;right:5%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOff.png" id="'+name+'Off" onclick="unmuteButton(event)">  \
			<img style="position:absolute;right:5%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOn.png" id="'+name+'On" onclick="muteButton(event)">  \
			<img style="position:absolute;left:5%; top:10%;width:40%; padding-bottom:10%;" src="images/StereoOff.png" id="'+name+'stereoOff" onclick="stereoOnOff(event)">  \
			<img style="position:absolute;left:5%; top:10%;width:40%; padding-bottom:10%;" src="images/StereoOn.png" id="'+name+'stereoOn" onclick="stereoOnOff(event)">  \
			<img style="position:absolute;right:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOff.png" id="'+name+'AGCOff" onclick="agcButton(event)">  \
			<img style="position:absolute;right:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOn.png" id="'+name+'AGCOn" onclick="agcButton(event)">  \
			<img style="position:absolute;left:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/HQOff.png" id="'+name+'HQOff" onclick="HQOnOff(event)">  \
			<img style="position:absolute;left:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/HQOn.png" id="'+name+'HQOn" onclick="HQOnOff(event)">  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA; font-size: 3vmin" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.name+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function removeChannelUI(obj) {
	trace2("Removing channel ",obj.name);
	let chan = document.getElementById(obj.displayID);
	if (chan != null) chan.remove();				// Remove from UI
	obj.displayID	= undefined;					// Reset all variables except channel #
	obj.name 	= "";						
	obj.gain	= 1;					
	obj.agc		= true;				
	obj.muted	= false;		
	obj.peak	= 0;		
	obj.seq		= 0;
}

function convertIdToObj(id) {						// Translate HTML DOM IDs to JS data objects
	id = id.substring(2);
	if (parseFloat(id)) id = parseFloat(id);
	if ((typeof(id) == "number") || (id == "0")) {			// 0 seems not to come through as a number
		id = channels[id];					// ID is channel number so get the channel object
	} else {
		id = eval(id);						// Convert the ID to the object (micIn or mixOut)
	}
	return id;
}

function recButton(e) {
trace2("rec");
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"talkOn");
	b.style.visibility = "hidden";
	id = convertIdToObj(id);
	recording = true;
}

function muteButton(e) {
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"On");
	b.style.visibility = "hidden";
	id = convertIdToObj(id);
	id.muted = true;
	if (micIn.muted) {						// Sync up UI mute buttons with mute state (mixer can de-sync them)
		document.getElementById('micMuted').style.visibility = "visible";
		document.getElementById('micOpen').style.visibility = "hidden";
	}
}

function unmuteButton(e) {
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"On");
	b.style.visibility = "inherit";
	id = convertIdToObj(id);
	id.muted = false;
	if (!micIn.muted) {						// Sync up UI mute buttons with mute state (mixer can de-sync them)
		document.getElementById('micMuted').style.visibility = "hidden";
		document.getElementById('micOpen').style.visibility = "visible";
		if (forcedMute) {					// If UI mute state was forced due to high threshold force mic open
trace2("FORCE UNmute");
			micIn.gate = 2 * Math.round(soundcardSampleRate/ChunkSize);				
			forcedMute = false;				// Not strictly necessary, but as we are clearly unmuted may as well unforce too
		}
	}
}

function agcButton(e) {
	let id = event.target.parentNode.id;
	let oid = convertIdToObj(id);
	let b = document.getElementById(id+"AGCOn");
	if (oid.agc) {
		b.style.visibility = "hidden";
	} else {
		b.style.visibility = "inherit";
	}
	oid.agc = !oid.agc;
}

function stereoOnOff(e) {
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"stereoOn");
	if (stereoOn) {
		b.style.visibility = "hidden";
		stereoOn = false;
	} else {
		b.style.visibility = "inherit";
		stereoOn = true;
	}
}

function HQOnOff(e) {
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"HQOn");
	if (HQOn) {
		b.style.visibility = "hidden";
		HQOn = false;
	} else {
		b.style.visibility = "inherit";
		HQOn = true;
	}
}

var slider = {
	dragging:false,							// Flag if slider dragging is happening
	dragStartY:0,							// Y coord where dragging started
	dragStartPct:0,							// start % from bottom for dragged slider
};

function sliderDragStart(event) {
	slider.dragging = true;
	event.target.style.cursor='pointer';				// Make pointer look right
	slider.dragStartY = event.clientY;				// Store where the dragging started
	if (isNaN(slider.dragStartY)) 
		slider.dragStartY = event.touches[0].clientY;		// If it is NaN must be a touchscreen
	let id = event.target.parentNode.id;
	let o = document.getElementById(id+"Slider");
	slider.dragStartPct = parseFloat(o.style.bottom);		// Get the slider's current % position
}

function sliderDrag(event) {
	if (slider.dragging) {
		let y = event.clientY;					// Get current cursor Y coord
		if (isNaN(y)) y = event.touches[0].clientY;		// If it is NaN we must be on a touchscreen
		y = (slider.dragStartY - y);				// Get the cursor positon change
		let pct = (y/event.target.clientHeight*0.65)*100;	// Calculate the change as a % of the range (0.65 is a fudge... coords are wrong but life is short)
		p = slider.dragStartPct + pct;				// Apply the change to the initial position
		let id = event.target.parentNode.id;
		let o = document.getElementById(id+"Slider");
		if (p < 8) p = 8;					// Limit slider movement
		if (p > 65) p = 65;
		o.style.bottom = p;					// Move the slider to the desired position
		let agc = document.getElementById(id+"AGCOn");
		agc.style.visibility = "hidden";				// By sliding the fader AGC is switched off. Hide indicator
		let gain;						// Now calculate the gain this position implies
		if (p < 42) 						// Inverse equations used for slider positioning
			gain = (p -8)/34;
		else
			gain = (p - 39.5)/2.5;
		id = convertIdToObj(id);				// Get the js object ID for this UI element
		id.gain = gain;						// Set the object's gain level 
//		if (id.targetGain != undefined) id.targetGain = gain;	// If this object has a target gain manually set it too
		id.agc = false;						// AGC is now off for this object
	}
}

function sliderDragStop(event) {
	event.target.style.cursor='default';
	slider.dragging = false;
}

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

function avgValue( arr ) { 						// Find average value in an array
	let t = 0;
	for (let i =  0; i < arr.length; i++) {
		t += Math.abs(arr[i]);					// average ABSOLUTE value
	}
	return (t/arr.length);
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
	if ((maxLevel * targetGain) > ceiling) { 				// If applying target gain level takes us over the ceiling
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

function applyGain( audio, gain ) {					// Apply a simple gain level to a sample
	for (let i=0; i<audio.length; i++)
		audio[i] = audio[i] * gain;
}

function fadeUp(audio) {						// Fade sample linearly over length
	for (let i=0; i<audio.length; i++)
		audio[i] = audio[i] * (i/audio.length);
}

function fadeDown(audio) {						// Fade sample linearly over length
	for (let i=0; i<audio.length; i++)
		audio[i] = audio[i] * ((audio.length - i)/audio.length);
}

var thresholdBands = [0.0001, 0.0002, 0.0003, 0.0005, 0.0007, 0.001, 0.002, 0.003, 0.005, 0.007, 0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.2, 0.3, 0.5, 0.7, 1, 2];
var levelCategories = new Array(thresholdBands.length).fill(0);		// Categorizer to build histogram of packet levels
function levelClassifier( v ) {
	for (let i=0; i<thresholdBands.length; i++) {
		if (v < thresholdBands[i]) {
			levelCategories[i]++;
			break;
		}
	}
}

function setNoiseThreshold () {						// Set the mic threshold to remove most background noise
	let max = 0;
	for (let i=0; i<14; i++)
		if (levelCategories[i] > max) {				// Find the peak category for sample levels
			max = levelCategories[i];
			noiseThreshold = thresholdBands[i];		// Threshold set to remove all below the peak
		}
	noiseThreshold = noiseThreshold * 1.2;				// Give noise threshold a little boost
trace2("Noise threshold: ",noiseThreshold);
	if (max > 0)
		for (let i=0; i<14; i++)
			levelCategories[i] = 
				((levelCategories[i]/max)*100.0);	// Keep old data to obtain slower threshold changes
}

function getPeaks( audio, size ) {
	let pos = 0;
	let peaks = [];
	while (pos < audio.length) {
		peaks.push(maxValue(audio.slice(pos,pos+size)));
		pos += size;
	}
	return peaks;
}

const peakWindow = 1024;						// Samples that enter into each peak reading for echo analysis
const nPeaks = 30;							// How many peaks to buffer for echo analysis and dynamic thresholds
var outputPeaks = new Array(nPeaks).fill(0);				// Buffer mic peaks here for delayed mic muting using dynamic thresholds
var micPeaks = new Array(nPeaks).fill(0);				// Buffer mic peaks for correlation analysis
var gateDelay = Math.ceil(40 * peakWindow/ChunkSize);			// Number of chunks the gate stays open for (corresponds to about 0.25s)
var openCount = 0;							// Count how long the gate is open to deal with steadily higher bg noise
var gateJustClosed = false;						// Flag to trigger bg noise measurement. 
var initialNoiseMeasure = gateDelay;					// Want to get an inital sample of bg noise right after the echo test
var extra = 3;								// A multiplier used to increase threshold factor. This grows with every breach
var oldFactor = 30;							// Factor before conencting headphones. Starts at default high value just in case.

function processAudio(e) {						// Main processing loop
	// There are two activities here (if not performing an echo test that is): 
	// 1. Get Mic audio, down-sample it, buffer it, and, if enough, send to server
	// 2. Get audio buffered from server and send to speaker
	enterState( audioInOutState );					// Log time spent here

	let inDataL = e.inputBuffer.getChannelData(0);			// Audio from the left mic
	let inDataR = e.inputBuffer.getChannelData(1);			// Audio from the right mic
	let outDataL = e.outputBuffer.getChannelData(0);		// Audio going to the left speaker
	let outDataR = e.outputBuffer.getChannelData(1);		// Audio going to the right speaker
	let outDataV = e.outputBuffer.getChannelData(2);		// Venue audio going to be processed

	if (echoTest.running == true) {					// The echo test takes over all audio
		let output = runEchoTest(inDataL);			// Send the mic audio to the tester
		for (let i in output) {					// and get back audio to reproduce
			outDataL[i] = output[i];			// Copy audio to output
			outDataR[i] = output[i];			// Copy audio to output
		}
		enterState( idleState );				// This test stage is done. Back to Idling
		return;							// Don't do anything else while testing
	} 

	// 1. Get Mic audio, buffer it, and send it to server if enough buffered
	if (socketConnected) {						// Need connection to send
		let micAudioL = [];					// Our objective is to fill these with audio
		let micAudioR = [];					
		let peaks = getPeaks(inDataL, peakWindow);		// Get peaks in raw left audio buffer
		micPeaks.push(...peaks);				// Keep buffer of mic peaks to analyze relation between input and output
		micPeaks.splice(0,peaks.length);			// Remove old values to keep buffer to size
		let mP = maxValue(peaks);				// Get overall peak of raw mic for gate control
		if (performer) micIn.gate = gateDelay			// Performer's mic has no gate
		else {							// Everyone else has to fight to keep the gate open
			let adjNoiseFloor = (openCount < 100)?		// The gate gets harder to keep open
				myNoiseFloor : myNoiseFloor * 1.5;	// after being open a time (100 Chunks)
			if ((micIn.gate > 0) && (mP > noiseThreshold)	// Keep gate open for anything above centrally controlled venue noise floor
				&& (mP > adjNoiseFloor)) {		// and above my background noise floor that increases after a period
				if (micIn.gate < gateDelay) micIn.gate = gateDelay;			
				openCount++;				// Count how long the gate is open to make it harder to stay open
			} else if ((mP > micIn.threshold) 		// Gate shut. Open if audio is above dynamic threshold
				&& (mP > noiseThreshold)		// and above centrally controlled venue noise floor
				&& (mP > adjNoiseFloor)) {		// and above my adjusted background noise floor
				micIn.gate = gateDelay;			
			} 
		}
		if ((gateJustClosed) && (micIn.gate == 0)) {		// If the gate closed in the previous loop capture gateDelay of micPeaks as bg noise (+20% margin)
			myNoiseFloor = maxValue(micPeaks.slice(-1*gateDelay*ChunkSize/peakWindow)) * 1.2;	
trace2("noiseFloor ",myNoiseFloor," MIC ",micPeaks.map(a => a.toFixed(3)));
			gateJustClosed = false;
		}
		if (initialNoiseMeasure > 0) {				// Right at the start the user is probably quiet
			initialNoiseMeasure--;				// so this is a good time to measure their bg noise level
			if (initialNoiseMeasure == 0) 			// which is important for cutting unwanted mic input
				gateJustClosed = true;			// Once enough levels are in the micPeaks buffer trigger a measurement of noise
		}
		if (micIn.muted) micIn.gate = 0;			// Mute means the gate is shut. No questions asked.
		if ((micIn.gate > 0)) {					// If the gate is open prepare audio for sending
			micAudioL = inDataL;
			micAudioR = inDataR;
			micIn.gate--;					// Gate slowly closes
			if (micIn.gate == 0) {
				gateJustClosed = true;			// If the gate just closed flag so that bg noise can be measured
				openCount = 0;				// Reset gate open counter resetting thresholds to initial levels
			}
		} else {						// Gate closed. Fill with silence.
			micAudioL = new Array(ChunkSize).fill(0);
			micAudioR = new Array(ChunkSize).fill(0);
		}
		micBufferL.push(...micAudioL);				// Buffer mic audio L
		micBufferR.push(...micAudioR);				// Buffer mic audio R
		while (micBufferL.length > adjMicPacketSize) {		// While enough audio in buffer 
			let audioL = micBufferL.splice(0, adjMicPacketSize);		// Get a packet of audio
			let audioR = micBufferR.splice(0, adjMicPacketSize);		// for each channel
			let audio = {mono8:[],mono16:[]};		// default empty audio and perf objects to send
			let perf = false;				// By default we believe we are not the performer
			let peak = 0;					// Note: no need for perf to set peak
			if (performer) {				// If we actually are the performer 
				if (!micIn.muted) {			// & not muted prepare our audio for HQ stereo 
					let a = prepPerfAudio(audioL, audioR);	
					perf = zipson.stringify(a);	// and compress audio fully
				} else 					// send silent perf audio
					perf = zipson.stringify({mono8:[],mono16:[],mono32:[],stereo8:[],stereo16:[],stereo32:[]});
			} else {					// Standard audio prep - always mono
				let mono8 = [], mono16 = [], mono32 = [], stereo8 = [], stereo16 = [], stereo32 = [];
				audio = reSample(audioL, downCache, PacketSize);	
				let obj = applyAutoGain(audio, micIn);	// Amplify mic with auto limiter
				if (obj.peak > micIn.peak) 
					micIn.peak = obj.peak;		// Note peak for local display
				peak = obj.peak				// peak for packet to be sent
				micIn.gain = obj.finalGain;		// Store gain for next loop
				if ((peak == 0) || (micIn.muted) || 	// Send empty packet if silent, muted
					(serverMuted)) { 		// or muted by server 
					peak = 0;
				} else {
					let j=0, k=0, s, d;
					for (let i=0; i<audio.length; i+=2) {	// Multiple sample-rate encoding:
						s = (audio[i] + audio[i+1])/2;	// Organises audio such that the server
						d = (audio[i] - audio[i+1])/2;	// can choose to reduce BW use
						mono8[j] = s;			// removing high frequencies from audio
						mono16[j] = d; j++		// just by ignoring data
					}
				}
				audio = {mono8,mono16,mono32,stereo8,stereo16,stereo32};	
				let a = zipson.stringify(audio);		// Compressing and uncompressing
				audio = zipson.parse(a);			// Saves 65% of bandwidth on its own!
			}
			let sr = performer ? PerfSampleRate : SampleRate;
			let now = new Date().getTime();
			let packet = {
				name		: myName,		// Send the name we have chosen 
				audio		: audio,		// Audio block
				perfAudio	: perf,			// Performer audio block
				liveClients	: 1,			// This is audio from a single client
				sequence	: packetSequence,	// Usefull for detecting data losses
				timestamp	: now,			// Used to measure round trip time
				peak 		: peak,			// Saves others having to calculate again
				channel		: myChannel,		// Send assigned channel to help server
				recording	: recording,		// Flag used for recording - test function
				sampleRate	: sr,			// Send sample rate to help processing
				group		: myGroup,		// Group name this user belongs to
				rtt		: rtt1,			// Send my rtt measurement for server monitoring
				chatText	: chatText,		// Any text that has been input for the chat
			};
			socketIO.emit("u",packet);
			chatText = "";					// After sending the chat text we clear it out
			let len=JSON.stringify(packet).length/1024;
			bytesSent += len;
			if (!performer) {
				packetBuf.push(packet);			// If not performer add packet to buffer for echo cancelling 
			}
			packetsOut++;					// For stats and monitoring
			packetSequence++;
		}
	}

	// 2. Take audio buffered from server and send it to the speaker
	let outAudioL = [], outAudioR = [];					
	if ((!smoothingNeeded)||(spkrBufferL.length > maxBuffSize/2)) {	// If no current shortages or buffer now full enough to restart
		if (spkrBufferL.length > ChunkSize) {			// There is enough audio buffered
			outAudioL = spkrBufferL.splice(0,ChunkSize);	// Get same amount of audio as came in
			outAudioR = spkrBufferR.splice(0,ChunkSize);	// for each channel
			if (smoothingNeeded) {				// We had a shortage so now we need to smooth audio re-entry 
				for (let i=0; i<400; i++) {		// Smoothly ramp up from zero to one
					outAudioL[i] = outAudioL[i]*(1-smooth[i]);
					outAudioR[i] = outAudioR[i]*(1-smooth[i]);
				}
				smoothingNeeded = false;
			}
		} else {						// Not enough audio.
			shortages++;					// For stats and monitoring
			if (pitch < pitchLimit) pitch++;		// Increase amount of data from each packet to reduce shortages
			let shortfall = ChunkSize-spkrBufferL.length;
			bytesShort += shortfall;
			outAudioL = spkrBufferL.splice(0,spkrBufferL.length);	// Take all that remains and complete with 0s
			outAudioR = spkrBufferR.splice(0,spkrBufferR.length);	// Take all that remains and complete with 0s
			let t = (spkrBufferL.length < 400)? 			// Transition to zero is as long as remaining audio
				spkrBufferL.length : 400;			// up to a maximum of 400 samples
			for (let i=0; i<t; i++) {				// Smoothly drop to zero to reduce harsh clicks
				outAudioL[i] = outAudioL[i]*smooth[Math.round(i*400/t)];
				outAudioR[i] = outAudioR[i]*smooth[Math.round(i*400/t)];
			}
			smoothingNeeded = true;
			let zeros = new Array(shortfall).fill(0);
			outAudioL.push(...zeros);
			outAudioR.push(...zeros);
		}
	}
	if (((echoRisk) && (!performer) && (micIn.gate > 0) 		// If echo is likely and we are not the performer, & the mic is on 
		&& (echoTest.factor > 0.5)) 				// and our echo factor is appreciable
		|| (outAudioL.length == 0)) {				// or the output array is empty, output silence
		outAudioL = new Array(ChunkSize).fill(0); 
		outAudioR = new Array(ChunkSize).fill(0);
	}
	for (let i in outDataL) { 
		outDataL[i] = outAudioL[i];				// Copy left audio to outputL   TRY .slice() again... should be faster
		outDataR[i] = outAudioR[i];				// and right audio to outputR
	}
	// 2.1 Take venue audio from buffer and send to special output (identical to stereo performer and group audio)
	let outAudioV = [];
	if ((!smoothingNeededV)||(venueBuffer.length > maxBuffSize/2)) {// If no current shortages or venue buffer now full enough to restart
		if (venueBuffer.length > ChunkSize) {			// There is enough audio buffered
			outAudioV = venueBuffer.splice(0,ChunkSize);	// Get same amount of audio as came in
			if (smoothingNeeded) {				// We had a shortage so now we need to smooth audio re-entry 
				for (let i=0; i<400; i++) {		// Smoothly ramp up from zero to one
					outAudioL[i] = outAudioL[i]*(1-smooth[i]);
					outAudioR[i] = outAudioR[i]*(1-smooth[i]);
				}
				smoothingNeededV = false;
			}
		} else {						// Not enough audio.
			shortages++;					// For stats and monitoring
			if (pitch < pitchLimit) pitch++;		// Increase amount of data from each packet to reduce shortages
			outAudioV = venueBuffer.splice(0,venueBuffer.length);	// Take all that remains and complete with 0s
			let t = (venueBuffer.length < 400)? 			// Transition to zero is as long as remaining audio
				venueBuffer.length : 400;			// up to a maximum of 400 samples
			for (let i=0; i<t; i++) {				// Smoothly drop to zero to reduce harsh clicks
				outAudioV[i] = outAudioV[i]*smooth[Math.round(i*400/t)];
			}
			smoothingNeededV = true;
			let zeros = new Array(ChunkSize-venueBuffer.length).fill(0);
			outAudioV.push(...zeros);
		}
	}
	if (((echoRisk) && (!performer) && (micIn.gate > 0) 		// If echo is likely and we are not the performer, & the mic is on 
		&& (echoTest.factor > 0.5)) 				// and our echo factor is appreciable
		|| (outAudioV.length == 0)) {				// or our venue array is empty (due to a shortage), output silence
		outAudioV =  new Array(ChunkSize).fill(0);
	}
	for (let i in outDataV) { 
		outDataV[i] = outAudioV[i];				// Copy venue audio to it's special output
	}
	
	let now = new Date().getTime();					// Note time between audio processing loops
	delta = now - previous;
	if (delta > deltaMax) deltaMax = delta;				// Keep max and min as this indicates the 
	if (delta < deltaMin) deltaMin = delta;				// load the client is enduring. A big difference is bad.
	previous = now;

	// 2.2 Handle feedback and echo. 
	// 2.2.1 First analyze audio out and in to determine background noise level for general mic noise thresholding (all clients need this)
	let peaksL = getPeaks(outAudioL, peakWindow);			// Get peaks in all the output channels
	let peaksR = getPeaks(outAudioR, peakWindow);
	let peaksV = getPeaks(outAudioV, peakWindow);
	for (let i=0;i<peaksL.length;i++)				// Put the largest peaks in the outputPeaks array
		if (peaksL[i] > peaksR[i]) {
			if (peaksL[i] > peaksV[i])
				outputPeaks.push(peaksL[i]);
			else	outputPeaks.push(peaksV[i]);
		} else {
			if (peaksR[i] > peaksV[i])
				outputPeaks.push(peaksR[i]);
			else	outputPeaks.push(peaksV[i]);
		}
	outputPeaks.splice(0,peaksL.length);				// Remove old values to keep buffer to size
	if (!echoRisk) {						// We are running on a noise cancelling browser that has passed the echo test
		micIn.threshold = 0;					// No echo risk so no threshold needed
		enterState( idleState );				// We are done here. No need to analyze audio further for this browser
		return;
	}								// Build a rapid profile of audio output and input to help quick decision making
	let del = Math.round(echoTest.sampleDelay);			// Get latest output to input delay rounded to a whole number of chunks
	let sumOP = 0, sumMP = 0;
	for (let i=0;i<(outputPeaks.length - del);i++)			// Add up all the peaks of output that
		sumOP += outputPeaks[i];				// should register on the input channel (given the output to input delay)
	for (let i=del;i < micPeaks.length;i++)				// Add up all the input channel peaks
		sumMP += micPeaks[i];					// that may have been influenced by output as a result of audio feedback
	let nVs = (micPeaks.length-del);				// Number of values that correspond to each other in the mic and output peak buffers
	sumOP = sumOP/nVs; 
	sumMP = sumMP/nVs;
if (tracecount > 0) trace2("avgO:",sumOP.toFixed(2)," avgM:",sumMP.toFixed(2)," NF:",myNoiseFloor.toFixed(3)," eTf:",echoTest.factor.toFixed(1));
	let aLot = myNoiseFloor * 4;					// Enough output that can't be confused for noise is, say, 4x local bg noise
	if (aLot > 1) aLot = 1;						// Can't ouput more than 1 however!
	if ((sumOP >= aLot) && (sumMP < myNoiseFloor)) 			// If our output is significant and our input is less than background noise
		goodCount += ChunkSize;					// this would suggest we are no longer getting feedback (perhaps headphones are connected?)
	else goodCount = 0;
	if (goodCount > soundcardSampleRate) {				// If we have had a second of clear non-echo results in a row
trace2("HEADPHONES");
                micIn.threshold = (myNoiseFloor > noiseThreshold)?	// Echo risk appears low so set threshold to my local noise threshold
			myNoiseFloor : noiseThreshold; 			// or the system global noise threshold, whichever is higher
		if (echoTest.factor > 0) oldFactor = echoTest.factor;	// Keep pre-headphone factor because if they are unplugged we need to get back on the case
		echoTest.factor = 0;					// Drop the echo factor so that no threshold is set while echoRisk is low
		enterState( idleState );                                // We are done. Back to Idling
		return;
	}
	// 2.2.2 There is audio coming in and audio going out so there could be echo feedback. Convolve output over mic peaks and find delay and correlation coefficient
	let olen = outputPeaks.length;
	let mlen = micPeaks.length;			
	let conv = [];							// The convolution is stored here
	let convMin = 3, convMax = 16;					// No need to waste CPU working out values outside of this range of probable delay values
	for (let m = convMin; m < convMax; m++) {			// The convolution will determine the most likely output to input delay
		let sum = 0;						// by doing the convolution of the output over the input
		for (let o=0; o<mlen; o++) {
			sum += outputPeaks[o]*micPeaks[(m+o)%mlen];
		}
		conv.push(sum);						// Convolution results accumulate here. We are looking for a triangular peak ideally
	}							
	let max = 0, d = 0;						// Find the convolution peak position which corresponds to the delay
	for (let j=0; j<conv.length; j++) {
		if (max < conv[j]) {
			max = conv[j];
			d = j;
		}
	}
	d += convMin;							// The delay value is offset by the convolution minimum value
	let ratio = 0, num = 0;						// Calculate the average ratio of input to output for this delay
	let sumM = 0, sumT = 0, sumMT = 0, sumM2 = 0, sumT2 = 0;	// Correlation calculation variables
	for (let i=0; i<(olen-d); i++) {				// Find if there is a strong correlation between input and output
		let mp = micPeaks[i+d], tb = outputPeaks[i];		// as this will indicate if there is echo feedback or not
		if (tb >0) {ratio += mp/tb; num++;}
		sumM += mp;
		sumT += tb;
		sumMT += mp * tb;
		sumM2 += mp * mp;
		sumT2 += tb * tb;
	}
	let step1 = ((olen-d)*sumMT) - (sumM * sumT);
	let step2 = ((olen-d)*sumM2) - (sumM * sumM);
	let step3 = ((olen-d)*sumT2) - (sumT * sumT);
	let step4 = Math.sqrt(step2 * step3);
	let coef = step1 / step4;					// This correlation coeficient (r) is the key figure. > 0.8 is significant
	let thresh = 0.8;						// Standard theshold for accepting a correlation result
	ratio = ratio / num;						// Get average input/output ratio needed to set a safe echo supression threshold
	if ((echoTest.factor == 0) 					// If we have deemed echo risk temporarily zero,
		&& (sumMP > sumOP) && (sumMP > myNoiseFloor)) {		// but the mic is picking up a lot of sound, the headphones may be unplugged
trace2("SPEAKER ",oldFactor);
		thresh = 0.4;						// Accept less clear correlations as there is a serious risk of feedback now
//		micIn.gate = 0;						// Force the mic gate shut imemdiately just in case
//		echoTest.factor = oldFactor;				// Restore the pre-headphone threshold level
	}
	if ((coef > thresh) && (isFinite(ratio)) 			// Is there correlation between input & output, is the ratio sensible,
		&& (ratio < 80) && (ratio > 0.2)) {			// and is the ratio within reasonable limits?
		if (ratio > echoTest.factor) 				// Apply ratio to echoTest.factor. Quickly going up. Slowly going down.
			echoTest.factor = (echoTest.factor*3+ratio*extra)/4;	// extra factor is used to increase factor to stop breaches
		else
			echoTest.factor = (echoTest.factor*39+ratio*extra)/40;	// extra factor same as above
		echoTest.sampleDelay = 					// An accurate estimate of feedback delay is important for setting the correct threshold 
			(echoTest.sampleDelay*39 + d)/40;
if (tracecount > 0) {trace2("MIC ",micPeaks.map(a => a.toFixed(2))," OUT ",outputPeaks.map(a => a.toFixed(2))," CONV ",conv.map(a => a.toFixed(2))," R ",ratio.toFixed(1)," c ",coef.toFixed(1)," d ",d," eTf ",echoTest.factor.toFixed(2)," eTsD ",echoTest.sampleDelay.toFixed(2))}
else trace2("R ",ratio.toFixed(1)," c ",coef.toFixed(1)," d ",d," eTf ",echoTest.factor.toFixed(2)," eTsD ",echoTest.sampleDelay.toFixed(2));
		if (micIn.gate > 0) {					// Worst case... we have correlated feedback and the mic is open! 
			echoTest.factor = 40;				// Push feedback factor high 
			micIn.gate = 0;					// and force mic gate shut immediately
trace2("Breach detected. ");
		}
	}
tracecount--;
	// 2.2.3 We now have a new factor that relates output to input plus the delay from output to input. Use these to set a safe input threshold
	del = Math.round(echoTest.sampleDelay);				// Update latest output to input delay rounded to a whole number of peaks
	let sta = outputPeaks.length - del - 3;				// Start of threshold window in output peaks array (newest is last element)
	if (sta < 0) sta = 0;						// trim to start of array
	let end = sta + 6;						// end of threshold window in output peaks array
	if (end > outputPeaks.length) end = outputPeaks.length;		// trim to end of array
	let tempThresh;							// Adjusted threshold level temporary value
	tempThresh = maxValue( outputPeaks				// Apply most aggressive threshold in window around current delay 
		.slice(sta,end)) * echoTest.factor * mixOut.gain;	// multiply by input/output gain factor as well as mixOutGain 
	if (tempThresh > 1.5) tempThresh = 1.5;				// Mic input can be higher than 1 (amaxingly) but never as high as 1.5
	if (myNoiseFloor > tempThresh) tempThresh = myNoiseFloor;	// The local noise floor is the minimum threshold permitted
	if (noiseThreshold > tempThresh) tempThresh = noiseThreshold;	// And the system global noise threshold is another minimum that must be respected
	micIn.threshold = tempThresh;					// Set mic threshold according to output level to allow interruptions but avoid feedback
	// When output suddenly climbs after silence, on mobiles especially, over-compression can lead to input breaching the threshold. Stop this by blocking temporarily
//	let newPeak = maxValue(outputPeaks.slice(0,(peaksL.length-1)));	// Get the highest peak in this new Chunk of peaks
//	let oldPeak = outputPeaks[peaksL.length];			// Get the previous Chunk's ending peak value
//	if (blocked == 0) {						// If blocked flag is reset we can check for new reasons to block
//		if ((newPeak > oldPeak)	&& (newPeak > tempThresh)) {	// If our output is climbing there's a risk of feedback due to mic over amplification after silence
//trace2("BLOCKING");
//			blocked = Math.round(soundcardSampleRate/ChunkSize);	// block the threshold for 1 second of chunks to stop mic input
//			micIn.threshold = 1.5;				// Override the mic threshold with a forced blocking value while we are blocked
//		} 
//	}
//	if (blocked > 0) {
//		blocked--;						// Threshold is blocked at max to completely stop feedback. Count back until unblocked.
//		if (blocked == 0) {
//			blocked = -1*Math.round(soundcardSampleRate/ChunkSize);	// After the blocked period we have to look for the same amunt of silence
//trace2("LOOKING");
//		}
//	}
//	if (blocked < 0) {						// Searching for prolonged quiet in output
//		if (newPeak < tempThresh) blocked++;			// Our output is low enough that mic may increase in sensitivity
//		else blocked = -1*Math.round(soundcardSampleRate/ChunkSize);	// otherwise start counting silence again because mic will have reset too
//	}
	enterState( idleState );					// We are done. Back to Idling
}

function prepPerfAudio( audioL, audioR ) {				// Performer audio is HQ and possibly stereo
	let stereo = false;						// Start by detecting if there is stereo audio
	if (stereoOn) for (let i=0; i<audioL.length; i++) 		// If user has enabled stereo 
		if (audioL[i] != audioR[i]) stereo = true;		// check if the signal is actually stereo
	audioL = reSample(audioL, downCachePerfL, PerfPacketSize);	
	if (stereo) {							// If stereo the right channel will need processing
		audioR = reSample(audioR, downCachePerfR, PerfPacketSize);	
	}
	let obj;
	if (stereo) {							// Stereo level setting 
		let peakL = maxValue(audioL);				// Set gain according to loudest channel
		let peakR = maxValue(audioR);
		if (peakL > peakR) {
			obj = applyAutoGain(audioL, micIn);		// Left sets the gain
			applyGain(audioR, obj.finalGain);		// and right follows
		} else {
			obj = applyAutoGain(audioR, micIn);		// Right sets the gain
			applyGain(audioL, obj.finalGain);		// and left follows
		}
	} else obj = applyAutoGain(audioL, micIn);			// For mono just use left channel
	if (obj.peak > micIn.peak) 
		micIn.peak = obj.peak;					// Note peak for local display
	micIn.gain = obj.finalGain;					// Store gain for next loop
	let LplusR = [], LminusR = [];					// Build mono and stereo (difference) data
	if (stereo) for (let i=0; i<audioL.length; i++) {
		LplusR[i] = audioL[i] + audioR[i];
		LminusR[i] = audioL[i] - audioR[i];
	} else LplusR = audioL;						// Just use the left signal if mono
	let mono8 = [], mono16 = [], mono32 = [], stereo8 = [], stereo16 = [], stereo32 = [];
	let j=0, k=0; 
	for (let i=0; i<LplusR.length; i+=4) {				// Multiple sample-rate encoding:
		let s1,s2,d1,d2,s3,d3;					// This encoding allows the server to discard blocks
		s1 = (LplusR[i] + LplusR[i+1])/2;			// and reduce network load by simply reducing the
		d1 = (LplusR[i] - LplusR[i+1])/2;			// high frequency content of performer audio
		s2 = (LplusR[i+2] + LplusR[i+3])/2;
		d2 = (LplusR[i+2] - LplusR[i+3])/2;
		s3 = (s1 + s2)/2;
		d3 = (s1 - s2)/2;
		mono8[j] = s3;
		mono16[j] = d3; j++
		mono32[k] = d1; k++;
		mono32[k] = d2; k++;
	}
	j=0, k=0;
	if (stereo) for (let i=0; i<LminusR.length; i+=4) {		// Repeat MSRE for stereo difference audio
		let s1,s2,d1,d2,s3,d3;		
		s1 = (LminusR[i] + LminusR[i+1])/2;	
		d1 = (LminusR[i] - LminusR[i+1])/2;
		s2 = (LminusR[i+2] + LminusR[i+3])/2;
		d2 = (LminusR[i+2] - LminusR[i+3])/2;
		s3 = (s1 + s2)/2;
		d3 = (s1 - s2)/2;
		stereo8[j] = s3;
		stereo16[j] = d3; j++
		stereo32[k] = d1; k++;
		stereo32[k] = d2; k++;
	}
	if (!HQOn) { mono32=[]; stereo32=[];}				// If user has switched off HQ drop HQ audio bands
	let audio = {mono8,mono16,mono32,stereo8,stereo16,stereo32};	// Return an object for the audio
	return audio;
}

var micFilter1;								// Mic filters are adjusted dynamically
var micFilter2;
var context;
var reverb;								// Load reverb buffer once server channel assigned
var reverbFile = "";							// Name of reverb file loaded. To stop loading same file twice
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
	micAudioPacketSize = Math.round(PacketSize * 			// How much micAudio is needed to fill a Packet
		soundcardSampleRate / SampleRate);			// at our standard SampleRate (rounding error is an issue?)
	adjMicPacketSize = micAudioPacketSize;				// Start with adjusted mic packet size set at normal size
	micAccessAllowed = true;
	createOutputUI( mixOut );					// Create the output mix channel UI
	createMicUI( micIn );						// Create the microphone channel UI
	createChannelUI( venue );					// Create the venue channel UI

//	if (navigator.userAgent.toLowerCase().indexOf("firefox") != -1) {
//		echoRisk = false;
//	} else {
//		echoRisk = true;
//	}
tracef("Browser echoRisk is ",echoRisk);
	let liveSource = context.createMediaStreamSource(stream); 	// Create audio source (mic)
	let node = undefined;
	if (!context.createScriptProcessor) {				// Audio processor node
		node = context.createJavaScriptNode(ChunkSize, 2, 3);	// The new way is to use a worklet
	} else {							// but the results are not as good
		node = context.createScriptProcessor(ChunkSize, 2, 3);	// and it doesn't work everywhere
	}
	node.onaudioprocess = processAudio;				// Link the callback to the node

	micFilter1 = context.createBiquadFilter();			// Input low pass filter to avoid aliasing
	micFilter1.type = 'lowpass';
	micFilter1.frequency.value = HighFilterFreq;
	micFilter1.Q.value = 1;
	micFilter2 = context.createBiquadFilter();			// Input high pass filter to lighten audience sound
	micFilter2.type = 'highpass';
	micFilter2.frequency.value = LowFilterFreq;
	micFilter2.Q.value = 1;
	
	reverb = context.createConvolver();				// Reverb for venue ambience
	reverb.buffer = impulseResponse(1,16);				// Default reverb characteristic... simple exponential decay
	reverb.normalize = true;
	let splitter = context.createChannelSplitter();			// Need a splitter to separate venue from main audio
	let combiner = context.createChannelMerger();			// Combiner used to rebuild stereo image

	liveSource.connect(micFilter1);					// Mic goes to the lowpass filter
	micFilter1.connect(micFilter2);					// then to the highpass filter
	micFilter2.connect(node);					// then to the node where all the work is done
	node.connect(splitter);						// The output is L, R and Venue so need to split them

	splitter.connect(combiner,0,0);					// Perf & group stereo audio. Recombine L & R
	splitter.connect(combiner,1,1);
	combiner.connect(context.destination);				// And send this stereo signal direct to the output

//	splitter.connect(reverb,2);					// Send centre venue to the stereo reverb
	splitter.connect(context.destination,2);			// Send centre venue direct to output
	
	reverb.connect(context.destination);				// and finally feed the centre venue with reverb to the output 

	startEchoTest();
}

function loadVenueReverb(filename) {					// Load the venue reverb file to give ambience
	if (filename == reverbFile) return;				// Don't load the same file again
	if (filename == "") {						// If the file is empty then lets go for the basic reverb
		reverb.buffer = impulseResponse(1,16); 
		return;					
	}
	let ir_request = new XMLHttpRequest();				// Load impulse response to reverb
	ir_request.open("GET", filename, true);
	ir_request.responseType = "arraybuffer";
	ir_request.onreadystatechange = function () {
		if (this.readyState == 4 && this.status == 200) {
			context.decodeAudioData( ir_request.response, function ( buffer ) {
				reverb.buffer = buffer;
				reverbFile = filename;			// Note file loaded so we don't reload later
console.log(filename," loaded into reverb");
			});
		}
	};
	ir_request.send();
console.log("Requested to load ",filename);
}

function impulseResponse( duration, decay ) {
	let length = soundcardSampleRate * duration;
	let impulse = context.createBuffer(2, length, soundcardSampleRate);
	let impulseL = impulse.getChannelData(0);
	let impulseR = impulse.getChannelData(1);
	if (!decay) decay = 2.0;

	let b0, b1, b2, b3, b4, b5, b6;
	b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0.0;

	for (let i = 0; i < length; i++){
		let pink;
		let white = Math.random() * 2 - 1;
		b0 = 0.99886 * b0 + white * 0.0555179;
		b1 = 0.99332 * b1 + white * 0.0750759;
		b2 = 0.96900 * b2 + white * 0.1538520;
		b3 = 0.86650 * b3 + white * 0.3104856;
		b4 = 0.55000 * b4 + white * 0.5329522;
		b5 = -0.7616 * b5 - white * 0.0168980;
		pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
		pink *= 0.11; // (roughly) compensate for gain
		b6 = white * 0.115926;
									// Pink noise reverb option
//		let impulseC = pink * Math.pow(1 - i / length, decay);	
									// White noise reverb option
		let impulseC = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
									// Stereo reverb
		impulseL[i] = impulseC * Math.random();
		impulseR[i] = impulseC * Math.random();
	}
	return impulse;
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
var  vCache = [0.0,0.0];						// cache for venue mix to speaker
var  gLCache = [0.0,0.0];						// cache for group left mix to speaker
var  gRCache = [0.0,0.0];						// cache for group right mix to speaker
var  downCachePerfL = [0.0,0.0];					// cache for performer audio from mic
var  downCachePerfR = [0.0,0.0];					// can be stereo
var  upCachePerfM = [0.0,0.0];						// cache for performer audio to mix and send to speaker
var  upCachePerfS = [0.0,0.0];						// can be stereo
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






// Echo testing code
//
var echoRisk = true;							// Flag that indicates if audio feedback is a risk. Firefox and headphones fix this
var echoTest = {
	running		: false,
	steps		: [16,8,128,64,32,1,0.5,0.2,0],			// Test frequencies and levels ended with 0
	currentStep	: 0,						// Points to test step being executed
	analysisStep	: 0,						// Points to test step being analysed
	tones		: [],						// Tones for each test are held here
	samplesNeeded 	: 0,						// Indicates how many samples still to store
	results		: [],						// Samples of each test buffer here
	delays 		: [],						// Array of final measurements
	delay		: 129,	// Default value			// Final delay measurement result stored here
	factor		: 4,	// Default value			// Final sensitivity factor stored here
	sampleDelay	: 6,	// Default value			// Final number of samples to delay dynamic threshold by
};
const pulseLength = 1024;						// No. of samples per pulse
const silence = 10 * 1024;						// No. of samples of silence after pulse to be sure to have heard it
echoTest.steps.forEach(i => {						// Build test tones
	if (i>1) {							// Create waves of different frequencies
		let audio = new Array(ChunkSize).fill(0);		// Start with an empty audio chunk
		let halfWave = pulseLength/(i*2);
		for  (let s=0; s < pulseLength; s++) {
			audio[s] = Math.sin(Math.PI * s / halfWave);
		}
		echoTest.tones[i] = audio;
	} else if (i > 0) {						// Create 1411Hz waves at different levels
		let audio = new Array(ChunkSize).fill(0);
		let halfWave = pulseLength/64;
		let gain = i;
		for  (let s=0; s < pulseLength; s++) {
			audio[s] = gain * Math.sin(Math.PI * s / halfWave);
		}
		echoTest.tones[i] = audio;
	}
});

function startEchoTest() {						// Test mic-speaker echo levels
	if (echoTest.running == false) {				// If not testing already
		trace2("Starting echo test");
		echoTest.running = true;				// start testing
		echoTest.currentStep = 0;				// start at step 0 and work through list
		echoTest.analysisStep = 0;				// reset the analysis pointer too
		echoTest.results = [];					// clear out results for new test
		echoTest.delays = [];					// clear out final mesaurements too
	}
}

function runEchoTest(audio) {						// Test audio system in a series of tests
	let outAudio;
	let test = echoTest.steps[echoTest.currentStep];
	if (test > 0) {							// 0 means analyze. >0 means emit & record audio
		if (echoTest.samplesNeeded <= 0) {			// If not storing audio must be sending test sound
			trace2("Running test ",test);
			outAudio = echoTest.tones[test]; 		// Get test sound for this test
			echoTest.results[test] = [];			// Get results buffer ready to store audio
			echoTest.samplesNeeded = silence;		// Request enough audio samples be recorded for each test
		} else {						// Not sending test sound so samples need to be stored
			echoTest.results[test].push(...audio);
			outAudio = new Array(ChunkSize).fill(0);	// return silence to send to speaker
			echoTest.samplesNeeded -= ChunkSize;		// We have captured a Chunk of samples of silence
			if (echoTest.samplesNeeded <= 0)		// If no more samples needed
				echoTest.currentStep++;			// move to next step
		}
	} else {							// Test completed. "0" indicates analysis phase.
		let review = echoTest.steps[echoTest.analysisStep];
		if (review > 0) {					// >0 means reviewing a test
			let results = echoTest.results[review];
			let name = "test " + review;
			trace2("Analyzing ",name);
			let pulse = echoTest.tones[review];
			let plen = pulse.length;
			let conv = [];					// convolution output
			for (let p=0; p<(results.length-plen); p++) {	// Run the convolution over results
				let sum = 0;
				for (let x=0; x<plen; x++) {
					sum += results[p+x]*pulse[x];
				}
				conv.push(sum);				// push each result to output
			}
			let max = 0;
			let edge = 0;
			for (let j=0; j<conv.length; j++)		// Find max = edge of pulse
				if (conv[j] > max) {
					max = conv[j];
					edge = j;
				}
			edge += ChunkSize;				// The edge does not include the first Chunk that included the pulse itself
			let delay = Math.round((edge*100)/soundcardSampleRate)*10;	// convert result to nearest 10mS
			trace2("Pulse delay is ",delay,"mS");
			echoTest.delays.push(delay.toFixed(0));		// Gather results in mS for each step
		} else {						// All tests have been analyzed. Get conclusions.
			trace2("Reviewing results");
			let counts = [];				// Collate results on mS values
			echoTest.delays.forEach(d => {if (counts[d] == null) counts[d] = 1; else counts[d]++});
			let winner = false;
			for (let c in counts) {				// If any result gets more than half the tests agreeing it's the winner
				if ((c > 0) && (counts[c] > echoTest.steps.length/2)) {
					trace2("Delay is ",c);
					winner = true;
					echoTest.delay = c;		// Store final delay result
					echoTest.sampleDelay = Math.ceil((echoTest.delay * soundcardSampleRate / 1000)/peakWindow);
					trace2("Sample delay is ",echoTest.sampleDelay);
				}
			}
			if (winner) {					// If delay obtained calculate gain factor
				echoRisk = true;			// We have heard our tones clearly so feedback can happen
				// Convert delay back to samples as start point for averaging level (removing pulse chunk length too)
				let edge = Math.round(echoTest.delay * soundcardSampleRate / 1000) - ChunkSize;
				let factors = [];			// Buffer results here
				// for each test <= 1 get avg level from edge for ChunkSize samples and get factor
				for (let i=0; i<(echoTest.steps.length-1); i++) {
					let t = echoTest.steps[i];
					if (t <= 1) {			// Level tests are <= 1
						let data = echoTest.results[t].slice(edge, (edge+pulseLength));
						let avg = avgValue(data);
						let factor = avg/(t * 0.637);	// Avg mic signal vs avg output signal
						trace2("Test ",echoTest.steps[i]," Factor: ",factor);
						factors.push(factor);	// Store result in buffer
					}
				}
				// Get average factor value
				echoTest.factor = avgValue(factors) * 3;// boost factor to give echo margin (IGNORING THIS FOR NOW!)
				echoTest.factor = 30;			// Force strong factor always. This gets updated in time but best to be cautious.
				echoRisk = true;			// We detected echo so there is an echo risk for sure
				trace2("Forced factor is ",echoTest.factor);
			} else {
				trace2("No clear result. Echo risk should be low.");		// No agreement, no result
				echoTest.factor = 0;			// A non-permanent result. Headphones may be unplugged later!
			}
			echoTest.running = false;			// Stop test 
		}
		echoTest.analysisStep++;				// Progress to analyze next step
	}
	return outAudio;
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
	let settingsBtn=document.getElementById('settingsBtn');
	settingsBtn.onclick = function () {
		trace2("Settings Button Pressed");
		toggleSettings();
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
var pauseTracing = true;						// Traces are off by default

// Reporting code. Accumulators, interval timer and report generator
//
var packetsIn = 0;
var packetsOut = 0;
var bytesSent = 0;
var bytesRcvd = 0;
var overflows = 0;
var shortages = 0;
var bytesOver = 0;
var bytesShort = 0;
var packetSequence = 0;							// Tracing packet ordering
var tracecount = 0;
var sendShortages = 0;
var spkrBuffPeak = 0;
var spkrBuffTrough = maxBuffSize;
var delta;
var previous;
var deltaMax = 0;
var deltaMin = 10000;
var pitch = 0;								// Adjustment to stretch/shrink audio data to avoid shortages & overflows
const pitchLimit = 12;							// Limit to pitch adjustment
function everySecond() {
	enterState( UIState );						// Measure time spent updating UI even for reporting!
	let netState = ((((rtt1-rtt5)/rtt5)>0.1) && (rtt5>400)) ? "UNSTABLE":"stable";
	if (!pauseTracing) {
//		trace("Idle=", idleState.total, " data in=", dataInState.total, " audio in/out=", audioInOutState.total," UI work=",UIState.total);
		trace(packetsOut,"/",packetsIn," over:",overflows,"(",bytesOver,") short:",shortages,"(",bytesShort,") RTT=",rtt.toFixed(1)," ",rtt1.toFixed(1)," ",rtt5.toFixed(1)," ",netState," a:",audience," sent:",bytesSent.toFixed(1)," rcvd:",bytesRcvd.toFixed(1));
		trace("Venue buffer:",venueBuffer.length," speaker buff:",spkrBufferL.length,"(",spkrBuffTrough," - ",spkrBuffPeak,") Delta max/min:",deltaMax,"/",deltaMin," pitch:",pitch);
//		trace2("sent:",bytesSent.toFixed(1)," rcvd:",bytesRcvd.toFixed(1));
	}
	if (performer == true) {
		document.getElementById("onair").style.visibility = "visible";
		micFilter1.frequency.value = PerfSampleRate/2.2;	// Change mic filter for performance audio
		micFilter2.frequency.value = 30;
	} else	{
		document.getElementById("onair").style.visibility = "hidden";
		micFilter1.frequency.value = HighFilterFreq		// Return mic filter to normal settings
		micFilter2.frequency.value = LowFilterFreq;
		if (liveShow)
			document.getElementById("live").style.visibility = "visible";
		else
			document.getElementById("live").style.visibility = "hidden";
	}
	if (liveShow)
		document.getElementById("ID"+mixOut.channel+"live").style.visibility = "inherit";
	else
		document.getElementById("ID"+mixOut.channel+"live").style.visibility = "hidden";
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
	packetsIn = 0;
	packetsOut = 0;
	bytesSent = 0;
	bytesRcvd = 0;
	overflows = 0;
	shortages = 0;
	bytesOver = 0;
	bytesShort = 0;
	rtt = 0;
	tracecount = 1;
	spkrBuffPeak = 0;
	spkrBuffTrough = maxBuffSize;
	deltaMax = 0;
	deltaMin = 10000;
//	pitch = Math.round((maxBuffSize/2 - spkrBufferL.length)/500);	// pitch error is related inversely to buffer over/under middle
	pitch = (pitch > pitchLimit)? pitchLimit : pitch;
	pitch = (pitch < (-1 * pitchLimit))? (-1 * pitchLimit) : pitch;
//	adjMicPacketSize = micAudioPacketSize + pitch;			// pitch is adjusted to keep things flowing smoothly
	updateUIMute();							// Mute buttons are dynamic depending on thresholds and user commands
	enterState( idleState );					// Back to Idling
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

// Timing counters
//
// We use these to measure how many miliseconds we spend working on events
// and how much time we spend doing "nothing" (supposedly idle)
function stateTimer() {
	this.name = "";
	this.total = 0;
	this.start = 0;
}
var idleState = new stateTimer(); 	idleState.name = "Idle";
var dataInState = new stateTimer();	dataInState.name = "Data In";
var audioInOutState = new stateTimer();	audioInOutState.name = "Audio In/Out";
var UIState = new stateTimer();	UIState.name = "UI updating";
var currentState = idleState;		currentState.start = new Date().getTime();
function enterState( newState ) {
	let now = new Date().getTime();
	currentState.total += now - currentState.start;
	newState.start = now;
	currentState = newState;
}



enterState( idleState );
