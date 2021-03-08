// Code for the Audio Context real time thread
//
var counter=0;

class VoiceVaultProcessor extends AudioWorkletProcessor {
	static get parameterDescriptors() {
	      return [{
	            name: 'size',
	            defaultValue: 1024,
	            minValue: 128,
	            maxValue: 100000,
		}];
	}

	constructor(options) {
		super(options);
		this.micBuffer = []; 			// Mic audio accumulates here until enough to send
		this.sendBuffer = []; 			// Mic audio to send is moved into here and sent to main.js
		this.receiveBuffer = []; 		// Multiple client buffers to store audio from server
		this.pointer = 0;			// Place to start reading receiveBuffer[0] from 
		this.max = 20000; 			// The most audio we will keep before removing old audio
		this.port.onmessage = (e) => { 		// Server has sent audio for a client
			var audio = e.data.audio;
			var receiveBuffer = this.receiveBuffer;
			var max = this.max;
			receiveBuffer.push( ...audio );
			// If the buffer has backlogged too much audio remove oldest audio down to max
			if (receiveBuffer.length > max) {
				console.log("BUFFER OVERFLOW. Chopping buffer in half. ");
				receiveBuffer.splice(max/2,max/2);
			}
		}
	}

	process (inputs, outputs, parameters) {
		// There are two tasks here: 1. buffer mic audio & 2. output buffered server audio
		// 1. Buffer and send Mic audio. 
		const inputL = inputs[0][0];				// Input from Mic
		const inputR = inputs[0][1];			
		const s = parameters.size;				// data amount needed to send
		let micBuffer = this.micBuffer;
		let sendBuffer = this.sendBuffer;
		if (inputL.length > 0) {
			micBuffer.push(...inputL);
			if (micBuffer.length >= s) {			// enough audio to send?
				sendBuffer = micBuffer.splice(0, s);
				this.port.postMessage({ 		// send the block of audio to main thread
					"audio": sendBuffer,
				});                   
			}
		}
		// 2. Output audio. 
		const outputL = outputs[0][0];				// left channel output
		const outputR = outputs[0][1];				// right channel output
		let l = inputR.length;					// Send as much audio as we receive
		let receiveBuffer = this.receiveBuffer;		
		let rl = receiveBuffer.length;
		let outAudio = [];
		if (rl > 0) {	
			if (rl >= l)
				outAudio = receiveBuffer.splice(0,l);	// Get same amount of audio as came in
			else
				outAudio = receiveBuffer.splice(0,rl);	// or get all that remains
			for (let i=0; i < l; i++) {
				if (i < outAudio.length)		// If there is outAudio use it
					outputL[i] = outputR[i] = outAudio[i];
				else					
					outputL[i] = outputR[i] = 0;	// else fill output with 0's 
			}
		}
		return true;
	}

};

registerProcessor('voicevault-processor', VoiceVaultProcessor);
