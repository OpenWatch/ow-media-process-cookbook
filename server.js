var kue = require('kue'),
express = require('express'),
ffmpeg = require('fluent-ffmpeg'),
glob = require('glob'),
fs = require('fs'),
exec = require('child_process').exec,
app = express.createServer(),
knox = require('knox'),
Q = require('q'),
request = require('request'),
MultiPartUpload = require('knox-mpu'),
raven = require('raven'),
path = require('path'),
jobs = kue.createQueue(); // create our job queue

var config_media = require('config').Media;
var config_process = require('config').Process;
var config_django = require('config').Django;

var raven_client = new raven.Client(config_process.sentryDSN);
raven_client.patchGlobal(function() {
  console.log('Uncaught exception, restarting server...');
  process.exit(1);
});

// AWS Settings
var aws_bucket = config_process.aws_bucket;
var aws_rejected_bucket = config_process.aws_rejected_bucket;
var aws_key = config_process.aws_key;
var aws_secret = config_process.aws_secret;
var aws_headers = { 'x-amz-acl': 'public-read' };

// File's home
var glob_path_prefix = config_media.capture_directory;
// Where to keep processed files relative to the raw data
var processed_subdir = config_process.processed_subdir;

// Knox S3 Client
var s3client = knox.createClient({
    key: aws_key,
    secret: aws_secret,
    bucket: aws_bucket
});

var reject_s3client = knox.createClient({
    key: aws_key,
    secret: aws_secret,
    bucket: aws_rejected_bucket
});

app.listen(config_process.port);
app.use(express.basicAuth(config_process.http_user, config_process.http_pw));
app.use(kue.app);

jobs.process('concatenate', 4, function(job, done) {
  var uuid = job.data.uuid;
  job.log('Starting ' + uuid);
  var input_directory = input_directory_for_uuid(uuid);
  var output_directory = output_directory_for_uuid(uuid);
  glob(input_directory + "/*.mp4", {nosort: false}, function (err, files) {
    files.sort(naturalSort);
    all_files = files;

    if(err){
      job.log("Error globbing!");
      job.log(err);
      stitch_fail(uuid, err);
    }
    job.log("Found files: " + files.length);
    job.data.file_count = files.length;
    job.data.completed_files_count = 0;
    job.save();

    pieces = files.length;
    var out_file;
    var out_files = [];
    var out_file_concat = '';
    // Convert files to MPEG-TS format
    var completion_callback = function(stdout, stderr) {
      if(typeof stderr != 'undefined'){
        job.log('FFmpeg individual cat stderr.\n\n' + String(stderr));
        //var raven_error = new Error('ffmpeg convert job error. stderror: ' + String(stderr) + ' stdout: ' + String(stdout));
        //raven_client.captureError(raven_error);
        //return done(raven_error);
      }
      completed_files_count = job.data.completed_files_count + 1;
      job.data.completed_files_count = completed_files_count;
      job.progress(completed_files_count, files.length);
      job.log('file has been converted succesfully');
      job.save();
      // If all files have been converted, concatenate them
      if (completed_files_count == files.length) {
        var cat_command = 'cat {0} > {1}/full.ts'.format(out_file_concat, output_directory);
        job.log('Meow: ' + cat_command);
        console.log('cat command: ' + cat_command);
        exec(cat_command, function (error, stdout, stderr) {
            if (error !== null) {
              var raven_error = new Error('ffmpeg concat job error. stderror: ' + String(stderr) + ' stdout: ' + String(stdout) + ' error: ' + String(error));
              raven_client.captureError(raven_error);
              job.log('Cat failed. What should we do?\n\n' + error);
              return done(error);
            }
            done();
        });
      }
    };

    for ( var i = 0, l = files.length; i < l; i++) {
      var input_file = files[i];
      job.log("starting ffmpeg for: " + input_file);
      //out_file = input_file.replace('mp4', 'ts');
      out_file = output_path_for_input_path(uuid, input_file);
      out_file_concat += ' ' + out_file + ' ';
      var proc = new ffmpeg({ source: input_file, priority: 10 })
      .withVideoCodec('copy')
      .withAudioCodec('copy')
      .addOption('-vbsf', 'h264_mp4toannexb')
      .addOption('-loglevel', 'fatal')
      .toFormat('mpegts')
      .saveToFile(out_file, completion_callback);
    }
  });
});

jobs.process('convert', 4, function(job, done) {
  var uuid = job.data.uuid;
  job.log('Starting ' + uuid);
  var output_directory = output_directory_for_uuid(uuid);
  var full_ts = output_directory + '/full.ts';
  var out_file = output_directory + '/full.mp4';
  var proc = new ffmpeg({ source: full_ts, priority: 10 })
  .withVideoCodec('copy')
  .withAudioCodec('copy')
  .addOption('-absf', 'aac_adtstoasc')
  .addOption('-loglevel', 'fatal')
  .toFormat('mp4')
  .onProgress(function(progress) {
    job.progress(progress.percent, 100);
  })
  .saveToFile(out_file, function(stdout, stderr) {
    // Cleanup TS files
    if(typeof stderr != 'undefined'){
      job.log('FFmpeg full convert stderr.\n\n' + String(stderr));
        //error = new Error('ffmpeg full convert job error. stderror: ' + String(stderr) + ' stdout: ' + String(stdout));
        //raven_client.captureError(error);
        //return done(error);
      }
    glob(output_directory + "/*.ts", {nosort: false}, function (err, files) {
      var file = '';
      for ( var i = 0, l = files.length; i < l; i++) {
        file = files[i];
        fs.unlink(file);
      }
      done();
    });
  });
});

jobs.process('thumbnail', 4, function(job, done) {
  var uuid = job.data.uuid;
  job.log('Starting thumbnail for ' + uuid);
  var output_directory = output_directory_for_uuid(uuid);
  var source_path = output_directory + '/full.mp4';
  if(!fs.existsSync(source_path)){
    //if full.mp4 not present, check for /hq/hq.mp4
    var hq_path = output_directory + "/hq/hq.mp4";
    if(fs.existsSync(hq_path)){
      source_path = hq_path;
    }
  }
  job.log('attempting screeenshot on file: ' + source_path);
  var proc = new ffmpeg({ source: source_path })
  .withSize('640x480')
  .takeScreenshots({
      count: 1,
      timemarks: ['50%'],
      filename: 'thumb'
    }, output_directory, function(err, filenames) {
      if(err){
        raven_client.captureError(new Error('ffmpeg thumbnail error ' + String(err)));
        job.log('Error creating thumbnail:');
        job.log(err);
        return done(err);
      }
      job.log('screenshots were saved');
      done();
  });
});

jobs.process('thumb_upload', 4, function(job, done) {
  var uuid = job.data.uuid;
  var up_token = job.data.up_token;
  var output_directory = output_directory_for_uuid(uuid);
  var thumb_source_path = output_directory + '/thumb.jpg';
  var thumb_s3_path = uuid + '/thumb.jpg';

  var upload_client = s3client;

  s3_exists(upload_client, thumb_s3_path)
  .then(function(exists){
    if(exists){
      upload_client = reject_s3client;
    }
  })
  .then(function(){
  return s3_upload({
            client: upload_client,
            s3_path: thumb_s3_path,
            file_path: thumb_source_path,
            acl_header: aws_headers,
            job: job
          });
  })
  .then(function(res){
    var thumb_s3_location = res['Location'];

    callEndpoint('sync_thumbnail', {
      public_upload_token: up_token,
      recording_id: uuid,
      recording_type: 'video',
      thumb: thumb_s3_location
      }, function(error, response, body) {
        return processCallEndpointCallback(error, response, body, job, done);
      }
    );

  }, function(err){
    return s3_error_handler(err, job, done);
  })
  .done();

});


jobs.process('lq_upload', 4, function(job, done) {
  var uuid = job.data.uuid;
  var up_token = job.data.up_token;
  var output_directory = output_directory_for_uuid(uuid);
  var lq_source_path = output_directory + '/full.mp4';
  var lq_s3_path = uuid + '/lq.mp4';

  var upload_client = s3client;

  s3_exists(upload_client, lq_s3_path)
  .then(function(exists){
    if(exists){
      upload_client = reject_s3client;
    }
  })
  .then(function(){
  return s3_upload({
            client: upload_client,
            s3_path: lq_s3_path,
            file_path: lq_source_path,
            acl_header: aws_headers,
            job: job
          });
  })
  .then(function(res){
    var lq_s3_location = res['Location'];

    callEndpoint('end_processing', {
      public_upload_token: up_token,
      recording_id: uuid,
      recording_type: 'video',
      path: lq_s3_location
      }, function(error, response, body) {
        return processCallEndpointCallback(error, response, body, job, done);
      }
    );
  }, function(err){
    return s3_error_handler(err, job, done);
  })
  .done();
});

jobs.process('hq_upload', 4, function(job, done) {
  var uuid = job.data.uuid;
  var up_token = job.data.up_token;
  var input_directory = input_directory_for_uuid(uuid);
  var hq_source_path = input_directory + '/hq/hq.mp4';
  var hq_s3_location = '';
  var hq_s3_path = uuid + '/hq.mp4';

  var upload_client = s3client;

  s3_exists(upload_client, hq_s3_path)
  .then(function(exists){
    console.log('s3 exists: ' + exists);
    if(exists === true){
      upload_client = reject_s3client;
    }
  })
  .then(function(){
  return s3_upload({
              client: upload_client,
              s3_path: hq_s3_path,
              file_path: hq_source_path,
              acl_header: aws_headers,
              job: job
            });
  })
  .then(function(res){
    console.log('Got res via promise');
    console.log(res);
    hq_s3_location = res['Location'];

    callEndpoint('sync_hq', {
      public_upload_token: up_token,
      recording_id: uuid,
      recording_type: 'video',
      path: hq_s3_location
      }, function(error, response, body) {
        return processCallEndpointCallback(error, response, body, job, done);
      }
    );
  }, function(err){
    return s3_error_handler(err, job, done);
  })
  .done();
});

/* API entry points */

app.post('/process_lq/:up_token/:uuid', function (req, res) {
  var uuid = req.params.uuid;
  var up_token = req.params.up_token;
  console.log('starting lq ' + uuid);
  res.send('Starting lq job...');
  start_concatenate_job(uuid, up_token);
});

app.post('/process_hq/:up_token/:uuid', function (req, res) {
  var uuid = req.params.uuid;
  var up_token = req.params.up_token;
  console.log('starting hq ' + uuid);
  res.send('Starting hq job...');
  start_upload_hq_to_s3_job(uuid, up_token);
});

/* functions to start jobs */

function generateErrorMessage(uuid, up_token, message) {
  var error_message = message;
  error_message += '\nuuid: ' + uuid;
  error_message += '\nup_token: ' + up_token;
  console.log(error_message);
  raven_client.captureMessage(error_message);
}

function start_concatenate_job(uuid, up_token) {
  console.log('start_concatenate_job');
  var job = jobs.create('concatenate', {
      title: uuid,
      uuid: uuid
  }).save();

  job.on('complete', function(){
    console.log('concatenate job complete');
    start_convert_job(uuid, up_token);
  }).on('failed', function(){
    // Raven will report Error when it happens for better feedback
    //generateErrorMessage(uuid, up_token, "concatenate job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_convert_job(uuid, up_token) {
  console.log('start_convert_job');
  var convert_job = jobs.create('convert', {
      title: uuid,
      uuid: uuid
  }).save();
  convert_job.on('complete', function(){
    console.log("convert job complete");
    start_thumbnail_job(uuid, up_token);
    start_upload_lq_to_s3_job(uuid, up_token);
  }).on('failed', function(){
    // Raven will report Error when it happens for better feedback
    //generateErrorMessage(uuid, up_token, "convert Job failed");
  }).on('progress', function(progress){
    //console.log('\r  convert job #' + convert_job.id + ' ' + progress + '% complete');
  });
}

function start_thumbnail_job(uuid, up_token) {
  console.log('start_thumbnail_job');
  var job = jobs.create('thumbnail', {
        title: uuid,
        uuid: uuid
    }).save();

  job.on('complete', function(){
    console.log("Thumbnailing complete.");
    start_upload_thumb_to_s3_job(uuid, up_token);
  }).on('failed', function(){
    generateErrorMessage(uuid, up_token, "thumbnailing Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_upload_lq_to_s3_job(uuid, up_token) {
  console.log('start_upload_lq_to_s3_job');
  var job = jobs.create('lq_upload', {
        title: uuid,
        uuid: uuid,
        up_token: up_token
    }).attempts(4).save();

  job.on('complete', function(){
    console.log("Upload lq complete.");
  }).on('failed', function(){
    generateErrorMessage(uuid, up_token, "Upload lq Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_upload_thumb_to_s3_job(uuid, up_token) {
  console.log('start_upload_thumb_to_s3_job');
  var job = jobs.create('thumb_upload', {
        title: uuid,
        uuid: uuid,
        up_token: up_token
    }).attempts(4).save();

  job.on('complete', function(){
    console.log("Upload thumb complete.");
  }).on('failed', function(){
    generateErrorMessage(uuid, up_token, "Upload thumb Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_upload_hq_to_s3_job(uuid, up_token) {
  console.log('start_upload_hq_to_s3_job');
  var job = jobs.create('hq_upload', {
        title: uuid,
        uuid: uuid,
        up_token: up_token
    }).attempts(4).save();

  job.on('complete', function(){
    console.log("Upload lq complete.");
    start_thumbnail_job(uuid, up_token);
  }).on('failed', function(){
    generateErrorMessage(uuid, up_token, "Upload lq Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_upload_to_failed_bucket_job(uuid, up_token) {
  console.log('start_upload_to_failed_bucket_job');
  var job = jobs.create('failed_upload', {
        title: uuid,
        uuid: uuid,
        up_token: up_token
    }).attempts(4).save();

  job.on('complete', function(){
    console.log("Upload conflict complete.");
  }).on('failed', function(){
    generateErrorMessage(uuid, up_token, "Upload conflict Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}


function s3_upload(s3_upload_params){
  var filesize = 10000;
  var part_size = 5242880;
  var total_parts = 1;
  var job = s3_upload_params.job;

  if(typeof job != 'undefined'){
    job.data.mpu_chunk = 0;
    job.save();
  }

  console.log('s3 mpu initiated for ' + s3_upload_params.file_path);

  fs.lstat(s3_upload_params.file_path, function(err, stats){
      console.log(stats.size);
      filesize = stats.size;
      total_parts = Math.ceil(filesize / part_size);
  });

  var deferred = Q.defer();

  if(path.extname(s3_upload_params.file_path) == ".jpg"){
    s3_upload_params.acl_header['Content-Type'] = "image/jpeg";
  }
  var upload = new MultiPartUpload(
    {
        client: s3_upload_params.client,
        objectName: s3_upload_params.s3_path,
        file: s3_upload_params.file_path,
        headers: s3_upload_params.acl_header,
        partSize: part_size
    }, function(err, res){
      console.log('MultiPartUpload callback for ' + s3_upload_params.file_path);
      console.log(err);
      console.log(res);
    }
  );

  upload.on('completed', function(body){
    console.log('s3 mpu completed for ' + s3_upload_params.file_path);
    console.log(body);
    deferred.resolve(body);
  });

  upload.on('failed', function(result){
    console.log('s3 mpu failed on ' + s3_upload_params.file_path);
    console.log(result);
    deferred.reject(new Error('s3 mpu failed'));
  });

  upload.on('uploaded', function(result){
    //console.log(result);
    if(typeof job != 'undefined'){
      var part_id = result.part;
      job.data.mpu_chunk = job.data.mpu_chunk + 1;
      job.save();

      job.progress(job.data.mpu_chunk, total_parts);
      console.log('s3 mpu part ' + job.data.mpu_chunk + ' / ' + total_parts + ' completed on ' + s3_upload_params.file_path);
    }
  });

  return deferred.promise;
}

/*
*
*  API
*
*/

function callEndpoint(endpoint, params, callback){

  console.log("Posting to..");
  console.log(makeEndpointUrl(endpoint));
  console.log('\n');

  request.post(
    makeEndpointUrl(endpoint),
    {
      form:params
    },
    callback
  );
}

function makeEndpointUrl(endpoint){
  var config = config_django;
  return config.api_schema + config.api_user + ':' + config.api_password + '@' + config.api_url + endpoint;
}

function processCallEndpointCallback(error, response, body, job, done) {
  console.log("Call endpoint response");
  if(typeof response == 'undefined'){
    console.log("Could not reach endpoint");
    job.log("Could not reach endpoint");
    return done(Error('Could not reach Django'));
  } else if(response.statusCode == 200){
    job.log(body);
    done();
    return;
  } else {
    console.log('Error: ' + response.statusCode);
    job.log('Error: ' + response.statusCode);
    job.log(body);
    return done(Error('Django error ' + response.statusCode));
  }
}

/* Utility functions */

function s3_error_handler(err, job, done) {
    console.log('S3 error:');
    console.log(err);
    raven_client.captureError(new Error('S3 error ' + String(err)));
    job.log('Error: ' + err);
    return done(err);
}

function input_directory_for_uuid(uid) {
  return glob_path_prefix + '/' + uid;
}

function output_directory_for_uuid(uid) {
  return glob_path_prefix + '/' + uid + processed_subdir;
}

function output_path_for_input_path(uid, input_path) {
  var deferred = Q.defer();
  // in: /internment/uuid/1.mp4
  // out: /internment/uuid/<processed_subdir>/1.mp4
  var filename = input_path.split('/');
  filename = filename[filename.length -1].replace('mp4', 'ts');
  var output_dir = output_directory_for_uuid(uid);
  if (!fs.existsSync(output_dir)) {
    fs.mkdirSync(output_dir);
  }
  return output_dir + '/' + filename;
}

// Returns a promise which is fulfilled with 'true', 'false'
// on success
function s3_exists(s3client, filepath){
  var deferred = Q.defer();
  try {
    s3client.head(filepath).on('response', function(res){
    //console.log(filepath + ' response statusCode: ' + res.statusCode);
    if(res.statusCode === 404){
      deferred.resolve(false);
    } else {
      deferred.resolve(true);
    }
    }).end();
  } catch(err){
    deferred.reject(new Error('Request Failed'));
  }
  return deferred.promise;
}

// Lets us do pythonic {0}, {x}-style string substitution.
String.prototype.format = function() {
  var args = arguments;
  return this.replace(/{(\d+)}/g, function(match, number) {
    return typeof args[number] != 'undefined'
      ? args[number]
      : match
    ;
  });
};

/*
 * Natural Sort algorithm for Javascript - Version 0.7 - Released under MIT license
 * Author: Jim Palmer (based on chunking idea from Dave Koelle)
 * URL: http://www.overset.com/2008/09/01/javascript-natural-sort-algorithm/
 */

 function naturalSort (a, b) {
    var re = /(^-?[0-9]+(\.?[0-9]*)[df]?e?[0-9]?$|^0x[0-9a-f]+$|[0-9]+)/gi,
        sre = /(^[ ]*|[ ]*$)/g,
        dre = /(^([\w ]+,?[\w ]+)?[\w ]+,?[\w ]+\d+:\d+(:\d+)?[\w ]?|^\d{1,4}[\/\-]\d{1,4}[\/\-]\d{1,4}|^\w+, \w+ \d+, \d{4})/,
        hre = /^0x[0-9a-f]+$/i,
        ore = /^0/,
        i = function(s) { return naturalSort.insensitive && (''+s).toLowerCase() || ''+s },
        // convert all to strings strip whitespace
        x = i(a).replace(sre, '') || '',
        y = i(b).replace(sre, '') || '',
        // chunk/tokenize
        xN = x.replace(re, '\0$1\0').replace(/\0$/,'').replace(/^\0/,'').split('\0'),
        yN = y.replace(re, '\0$1\0').replace(/\0$/,'').replace(/^\0/,'').split('\0'),
        // numeric, hex or date detection
        xD = parseInt(x.match(hre)) || (xN.length != 1 && x.match(dre) && Date.parse(x)),
        yD = parseInt(y.match(hre)) || xD && y.match(dre) && Date.parse(y) || null,
        oFxNcL, oFyNcL;
    // first try and sort Hex codes or Dates
    if (yD)
        if ( xD < yD ) return -1;
        else if ( xD > yD ) return 1;
    // natural sorting through split numeric strings and default strings
    for(var cLoc=0, numS=Math.max(xN.length, yN.length); cLoc < numS; cLoc++) {
        // find floats not starting with '0', string or 0 if not defined (Clint Priest)
        oFxNcL = !(xN[cLoc] || '').match(ore) && parseFloat(xN[cLoc]) || xN[cLoc] || 0;
        oFyNcL = !(yN[cLoc] || '').match(ore) && parseFloat(yN[cLoc]) || yN[cLoc] || 0;
        // handle numeric vs string comparison - number < string - (Kyle Adams)
        if (isNaN(oFxNcL) !== isNaN(oFyNcL)) { return (isNaN(oFxNcL)) ? 1 : -1; }
        // rely on string comparison if different types - i.e. '02' < 2 != '02' < '2'
        else if (typeof oFxNcL !== typeof oFyNcL) {
            oFxNcL += '';
            oFyNcL += '';
        }
        if (oFxNcL < oFyNcL) return -1;
        if (oFxNcL > oFyNcL) return 1;
    }
    return 0;
}