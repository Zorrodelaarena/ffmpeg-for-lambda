
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
	
	if (!options.output || (!options.output.path && !options.output.postfix)) {
		result.error = new Error('output.path and output.postfix not set');
		finalCallback(result);
		return;
	}
	if (options.output.parameters && Array.isArray(options.output.parameters)) {
		ffParameters = ffParameters.concat(options.output.parameters);
	}
	if (!options.output.path) {
		ffParameters.push('-y');
		result.outputFile = tmp.fileSync({ discardDescriptor: true, postfix: options.output.postfix }).name;
	} else {
		result.outputFile = options.output.path;
	}
	ffParameters.push(result.outputFile);

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
