
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
 * @property {?Array} parameters string parameters sent into ffmpeg
 * @property {string} inputFile path to the file you want processed
 * @property {?string} outputFile path to ffmpeg output file. if not specified, one will be generated
 * @property {?string} outputFilePostfix if set and outputFile is not, the generated file will end in this
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

	var ffParameters = options['parameters'];
	if (!Array.isArray(ffParameters)) {
		ffParameters = [];
	}

	var inputFile = options['inputFile'];
	if (typeof inputFile !== 'string' || !fs.existsSync(inputFile)) {
		result.error = new Error('inputFile not set or not found');
		finalCallback(result);
		return;
	}
	ffParameters.push('-i');
	ffParameters.push(inputFile);

	var outputFile = options['outputFile'];
	if (typeof outputFile !== 'string' || outputFile === '') {
		var fileSyncSettings = { discardDescriptor: true };
		if (typeof options['outputFilePostfix'] === 'string') {
			fileSyncSettings.postfix = options['outputFilePostfix'];
		} else {
			result.error = new Error('outFile or outputFilePostix but be set');
			finalCallback(result);
			return;
		}
		outputFile = tmp.fileSync(fileSyncSettings).name;
		ffParameters.push('-y');
	}
	ffParameters.push(outputFile);
	result.outputFile = outputFile;

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
				result.size = fs.statSync(outputFile).size;
				result.stdout = stdout;
				result.stderr = stderr;
				if (result.size < 1) {
					result.error = new Error('outputFile was empty. check stdout and stderr for details');
				}
				finalCallback(result);
			});
		}
	]);
};
