
var fs = require('fs');
var child_process = require('child_process');
var async = require('async');
var tmp = require('tmp');
var shellescape = require('shell-escape');

var ffmpegPath = '';
var ffprobePath = '';

/**
 * @typedef {Object} FFmpegOptions
 * @property {?function} callback receives the results after finish
 * @property {InputParameters} input information about the input file
 * @property {OutputParameters} output information about the output file
 */

/**
 * @typedef {Object} InputParameters
 * @property {string} path to the file
 * @property {Array} parameters to be applied to the input file
 */

/**
 * @typedef {Object} OutputParameters
 * @property {string} path to the file
 * @property {?string} path to ffmpeg output file. if not specified, one will be generated
 * @property {?string} postfix if set and path is not, the generated file will end in this
 * @property {Array} parameters to be applied to the input file
 * @property {?boolean} matchInputRates should we match bit and sample rate of the source file (if possible?)
 */

/**
 * @typedef {Object} FFmpegResult
 * @property {Error} error set if there was an error
 * @property {int} size filesize of output file
 * @property {string} outputFile path to output file
 * @property {string} stdout stdout from ffmpeg
 * @property {string} stderr stderr from ffmpeg
 * @property {string} ffmpegCommand the command that was run (if there was one) (for debugging)
*/

/**
 * Runs ffmpeg
 * @param {FFmpegOptions} options
 * @returns {FFmpegResult}
 */
exports.ffmpeg = function (options) {

	var result = {
		error: null,
		size: 0,
		outputFile: '',
		stdout: '',
		stderr: '',
		ffmpegCommand: ''
	};

	if (typeof options !== 'object') {
		options = {};
	}

	var finalCallback = options['callback'];
	if (typeof finalCallback !== 'function') {
		finalCallback = function () { };
	}

	var ffParameters = [];
	if (!options.input || !options.input.path || !fs.existsSync(options.input.path)) {
		result.error = new Error('input.path not set or not found');
		finalCallback(result);
		return;
	}
	if (options.input.parameters && Array.isArray(options.input.parameters)) {
		ffParameters = ffParameters.concat(options.input.parameters);
	}
	ffParameters.push('-i');
	ffParameters.push(options.input.path);

	if (options.output) {
		if (options.output.matchInputRates) {
			var rateParameterGenerator = new RateParameterGenerator();
			rateParameterGenerator.matchSource(options.input.path, function (err) {
				if (err) {
					rateParameterGenerator.setBitRate(48000);
					rateParameterGenerator.setSampleRate(320000);
				}

			});
		}
		if (options.output.parameters && Array.isArray(options.output.parameters)) {
			ffParameters = ffParameters.concat(options.output.parameters);
		}
		if (!options.output.path && options.output.postfix) {
			ffParameters.push('-y');
			result.outputFile = tmp.fileSync({ discardDescriptor: true, postfix: options.output.postfix }).name;
			ffParameters.push(result.outputFile);
		} else if (options.output.path) {
			result.outputFile = options.output.path;
			ffParameters.push(result.outputFile);
		}
	}

	async.waterfall([
		// make sure we have ffmpeg somewhere we can run it
		function (callback) {
			if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
				var newFFmpegPath = tmp.fileSync({ discardDescriptor: true, prefix: 'ffmpeg-' }).name;
				child_process.exec('cp ' + __dirname + '/bin/ffmpeg ' + newFFmpegPath, function (error, stdout, stderr) {
					if (error) {
						result.stdout = stdout;
						result.stderr = stderr;
						result.error = new Error('Failed to copy ffmpeg to ' + newFFmpegPath);
						finalCallback(result);
					} else {
						ffmpegPath = newFFmpegPath;
						callback(null);
					}
				});
			} else {
				callback(null);
			}
		},
		// make sure we have run permissions
		function (callback) {
			fs.chmod(ffmpegPath, 0777, function (err) {
				if (err) {
					result.error = err;
					finalCallback(result);
				} else {
					callback(null);
				}
			});
		},
		// run ffmpeg
		function (callback) {
			result.ffmpegCommand = ffmpegPath + ' ' + shellescape(ffParameters);
			child_process.exec(result.ffmpegCommand, function (error, stdout, stderr) {
				if (result.outputFile !== '') {
					result.size = fs.statSync(result.outputFile).size;
					if (result.size < 1) {
						result.error = new Error('outputFile was empty. check stdout and stderr for details');
					}
				}
				result.stdout = stdout;
				result.stderr = stderr;
				finalCallback(result);
			});
		}
	]);
};

/**
 * Makes sure ffprobe is ready to run
 * @param {function} finalCallback
 */
function initializeFFProbe(finalCallback) {
	async.waterfall([
		// make sure we have ffmpeg somewhere we can run it
		function (callback) {
			if (!ffprobePath || !fs.existsSync(ffprobePath)) {
				var newFFProbePath = tmp.fileSync({ discardDescriptor: true, prefix: 'ffmpeg-' }).name;
				child_process.exec('cp ' + __dirname + '/bin/ffprobe ' + newFFProbePath, function (error, stdout, stderr) {
					if (error) {
						finalCallback(new Error('Failed to copy ffprobe to ' + newFFProbePath));
					} else {
						ffprobePath = newFFProbePath;
						callback(null);
					}
				});
			} else {
				callback(null);
			}
		},
		// make sure we have run permissions
		function (callback) {
			fs.chmod(ffprobePath, 0777, function (err) {
				if (err) {
					finalCallback(err);
				} else {
					finalCallback(null);
				}
			});
		}
	]);
}

/**
 * Gets a standardized ffprobe info dump
 * @param {string} path to the file
 * @param {function} callback called with (err, {Object} fileInfo)
 */
function getFFProbeInfo(path, callback) {
	initializeFFProbe(function (err) {
		if (err) return callback(err);

		var command = ffprobePath + ' ' + shellescape(['-i', path, '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams']);
		child_process.exec(command, function (error, stdout, stderr) {
			var fileInfo = JSON.parse(stdout);
			if (!fileInfo || !fileInfo.streams || !Array.isArray(fileInfo.streams) || !fileInfo.streams.length) {
				callback(new Error('no file info found in ' + stdout));
			} else {
				callback(null, fileInfo);
			}
		});
	});
}

function RateParameterGenerator() {

	var minSampleRate = 0;
	var minBitRate = 0;
	var forcedSampleRate = 0;
	var forcedBitRate = 0;
	var forcedCodec = '';

	var sourceCodec = '';
	var sourceSampleRate = 0;
	var sourceBitRate = 0;

	this.setMinSimpleRate = function (sampleRate) {
		minSampleRate = sampleRate;
	};

	this.setMinBitRate = function (bitRate) {
		minBitRate = bitRate;
	};

	this.setSampleRate = function (sampleRate) {
		forcedSampleRate = sampleRate;
	};

	this.setBitRate = function (bitRate) {
		forcedBitRate = bitRate;
	};

	this.setCodec = function (codec) {
		forcedCodec = codec;
	};

	this.matchSource = function (sourcePath, callback) {
		getFFProbeInfo(path, function (err, fileInfo) {
			if (err) return callback(err);

			var stream = fileInfo.streams[0];
			if (!stream.sample_rate) {
				return callback(new Error('Unable to parse sample rate from source'));
			}
			sourceSampleRate = stream.sample_rate;
			sourceCodec = stream.codec_name;
			sourceBitRate = stream.bit_rate;
			callback(null);
		});
	};

	this.generateParameters = function (newFormat) {
		let sr = sourceSampleRate;
		let br = sourceBitRate;
		if (forcedBitRate !== 0) {
			br = forcedBitRate;
		} else if (minBitRate !== 0) {
			br = Math.min(minBitRate, br);
		}
		if (forcedSampleRate !== 0) {
			sr = forcedSampleRate;
		} else if (minSampleRate !== 0) {
			sr = Math.min(minSampleRate, sr);
		}
		if (newFormat === 'mp3' || sourceCodec.indexOf('pcm') === -1) {
			return ['-ar', sr, '-ab', br];
		} else {
			var codec = sourceCodec;
			if (forcedCodec !== '') {
				codec = forcedCodec;
			} else if (newFormat === 'wav') {
				codec = codec.replace('be', 'le');
			} else if (newFormat === 'aiff') {
				codec = codec.replace('le', 'be');
			}
			return ['-ar', sr, '-acodec', codec];
		}
	};

}

/**
 * Gets the first bytes from the path and sends them to callback
 * @param {string} path to file
 8 @param {int} length the number of bytes to get
 * @param {function} callback called with (err, bytesAsString)
 */
function getFormatBytes(path, length, callback) {
	fs.open(path, 'r', function (err, fd) {
		if (err) return callback(err);
		var bytes = new Buffer(length);
		fs.read(fd, bytes, 0, length, 0, function (err, bytesRead, bytes) {
			if (err) return callback(err);
			callback(null, bytes.toString());
		});
	});
}

/**
 * Checks if the file at path has the first four bytes that match 
 * @param {string} path to file
 * @param {string} firstBytes the bytes you're looking for
 * @param {function} callback called with (err, boolean)
 */
function hasFirstBytes(path, firstBytes, callback) {
	getFormatBytes(path, firstBytes.length, function (err, bytes) {
		if (err) return callback(err, null);
		callback(null, bytes == firstBytes);
	});
}

/**
 * Checks if the given file at least has an AIFF header
 * @param {string} path to file
 * @param {function} callback called with (err, boolean)
 */
exports.isAiffFile = function (path, callback) {
	hasFirstBytes(path, 'FORM', callback);
};

/**
 * Checks if the given file at least has a WAV header
 * @param {string} path to file
 * @param {function} callback called with (err, boolean)
 */
exports.isWavFile = function (path, callback) {
	hasFirstBytes(path, 'RIFF', callback);
};

/**
 * Checks if the given file is a valid mp3 file
 * @param {string} path to file
 * @param {function} callback called with (err, boolean, details)
 */
exports.isMp3File = function (path, callback) {
	async.waterfall([
		function (cont) {
			exports.ffmpeg({
				callback: function (result) {
					var stderr = result.stderr + "\n";
					stderr = stderr.replace(/[^\n]+(Cannot read BOM value|Error reading frame)[^\n]+\n/mg, '').trim();
					if (stderr === '') {
						return cont(null);
					}
					var errorMessage = stderr.replace(new RegExp(path + ': ', 'mg'), '');
					errorMessage = errorMessage.replace(/\[[a-z0-9]+ @ 0x[0-9a-f]+\] |Last message repeated [0-9]+ times|Error while decoding stream #[0-9]+:[0-9]+: /mg, '');
					errorMessage = removeEmptiesFromArray(uniqueArray(trimArray(errorMessage.split("\n")))).join("\n");
					callback(null, false, errorMessage);
				},
				input: {
					path: path
				},
				output: {
					parameters: ['-v', 'error', '-f', 'null', '-']
				}
			});
		},
		function (cont) {
			exports.ffmpeg({
				callback: function (result) {
					if (result.stderr.match(/Stream #[0-9]+:[0-9]+ -> #[0-9]+:[0-9]+ \(mp3 /m)) {
						callback(null, true);
					} else {
						callback(null, false, 'File does not appear to have a proper MP3 stream');
					}
				},
				input: {
					path: path
				},
				output: {
					parameters: ['-v', 'info', '-f', 'null', '-']
				}
			});
		}
	]);
};

function trimArray(arr) {
	for (var i = 0, len = arr.length; i < len; i++) {
		arr[i] = arr[i].trim();
	}
	return arr;
}

function uniqueArray(arr) {
	return [...new Set(arr)];
}

function removeEmptiesFromArray(arr) {
	return arr.filter(elem => elem);
}

/**
 * Gets the number of streams in a file
 * @param {string} path to the file
 * @param {function} callback takes (error, channelCount)
 */
exports.getStreamCount = function (path, callback) {
	getFFProbeInfo(path, function (err, fileInfo) {
		if (err) return callback(err);

		callback(null, parseInt(fileInfo.streams[0].channels));
	});
};