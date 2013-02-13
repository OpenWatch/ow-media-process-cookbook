var kue = require('kue'),
express = require('express'),
ffmpeg = require('fluent-ffmpeg'),
glob = require('glob'),
fs = require('fs'),
exec = require('child_process').exec,
app = express.createServer(),
knox = require('knox'),
Q = require('q'),
MultiPartUpload = require('knox-mpu'),
jobs = kue.createQueue(); // create our job queue

// AWS Settings
var aws_bucket = 'openwatch-capture';
var aws_key = process.env.AWS_KEY;
var aws_secret = process.env.AWS_SECRET;

var config_media = require('config').Media;
var config_process = require('config').Process;
var config_django = require('config').Django;

// File's home
var glob_path_prefix = config_media.capture_directory;

// Knox S3 Client
var client = knox.createClient({
    key: aws_key,
    secret: aws_secret,
    bucket: aws_bucket
});

app.listen(config_process.port);
app.use(kue.app);
console.log('UI started on port 5001');

jobs.process('concatenate', 4, function(job, done) {
  var uuid = job.data.uuid;
  job.log('Starting ' + uuid);
  var recording_directory = directory_for_uuid(uuid);
  glob(recording_directory + "/*.mp4", {nosort: false}, function (err, files) {
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
    for ( var i = 0, l = files.length; i < l; i++) {
      var input_file = files[i];
      job.log("starting ffmpeg for: " + input_file);
      out_file = input_file.replace('mp4', 'ts');
      out_file_concat += ' ' + out_file + ' ';
      var proc = new ffmpeg({ source: input_file, priority: 10 })
      .withVideoCodec('copy')
      .withAudioCodec('copy')
      .addOption('-vbsf', 'h264_mp4toannexb')
      .toFormat('mpegts')
      .saveToFile(out_file, function(stdout, stderr) {
        completed_files_count = job.data.completed_files_count + 1;
        job.data.completed_files_count = completed_files_count;
        job.progress(completed_files_count, files.length);
        job.log('file has been converted succesfully');
        job.save();
        // If all files have been converted, concatenate them
        if (completed_files_count == files.length) {
          var cat_command = 'cat {0} > {1}/full.ts'.format(out_file_concat, recording_directory);
          job.log('Meow: ' + cat_command);
          console.log('cat command: ' + cat_command);
          exec(cat_command, function (error, stdout, stderr) {
              if (error !== null) {
                job.log('Cat failed. What should we do?\n\n' + error);
              }
              done();
          });
        }
      });
    }
  });
});

jobs.process('convert', 4, function(job, done) {
  var uuid = job.data.uuid;
  job.log('Starting ' + uuid);
  var recording_directory = directory_for_uuid(uuid);
  var full_ts = recording_directory + '/full.ts';
  var out_file = recording_directory + '/full.mp4';
  var proc = new ffmpeg({ source: full_ts, priority: 10 })
  .withVideoCodec('copy')
  .withAudioCodec('copy')
  .addOption('-absf', 'aac_adtstoasc')
  .toFormat('mp4')
  .onProgress(function(progress) {
    job.progress(progress.percent, 100);
  })
  .saveToFile(out_file, function(stdout, stderr) {
    // Cleanup TS files
    glob(recording_directory + "/*.ts", {nosort: false}, function (err, files) {
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
  var recording_directory = directory_for_uuid(uuid);
  var source_path = recording_directory + '/full.mp4';
  var proc = new ffmpeg({ source: source_path })
  .withSize('300x300')
  .takeScreenshots({
      count: 1,
      timemarks: ['50%'],
      filename: 'thumb'
    }, recording_directory, function(err, filenames) {
      if(err){
        job.log('Error creating thumbnail:');
        job.log(err);
        throw err;
      }
      job.log('screenshots were saved');
      done();
  });
});


jobs.process('lq_upload', 4, function(job, done) {
  var uuid = job.data.uuid;
  var up_token = job.data.up_token;
  var recording_directory = directory_for_uuid(uuid);
  var lq_source_path = recording_directory + '/full.mp4';
  var thumb_source_path = recording_directory + '/thumb.jpg';
  var lq_s3_location = '';
  var thumb_s3_location = '';
  var thumb_s3_path = uuid + '/thumb.jpg';
  var public_header = { 'x-amz-acl': 'public-read' };
  var lq_s3_path = uuid + '/lq.mp4';

  Q.allResolved([
    s3_upload({
              client: client,
              s3_path: lq_s3_path,
              file_path: lq_source_path,
              acl_header: public_header
            }),
    s3_upload({
              client: client,
              s3_path: thumb_s3_path,
              file_path: thumb_source_path,
              acl_header: public_header
           })
    ])
  .then(function(promises){
    var lq_s3_location, thumb_s3_location;
    if(promises[0].isFulfilled()){
      lq_s3_location = promises[0].valueOf()['Location'];
      // TODO: Get asset path
    }else{
      console.log('Exception value:');
      console.log(promises[0].valueOf().exception);
      throw new Error('s3 Exception');
    }

    if(promises[1].isFulfilled()){
      thumb_s3_location = promises[1].valueOf()['Location'];
    }else{
      console.log('Exception value:');
      console.log(promises[1].valueOf().exception);
      throw new Error('s3 Exception');
    }

    callEndpoint('end_processing', {
      public_upload_token: up_token,
      recording_id: uuid,
      recording_type: 'video',
      path: lq_s3_location,
      thumb: thumb_s3_location
      }, function(error, response, body) {
        job.log(body);
        if(response === undefined){
          job.log("Could not reach endpoint");
          throw new Error('Could not reach Django');
        } else if(response.statusCode == 200){
          job.log("Result!");
          done();
        } else {
          job.log('Error: ' + response.statusCode);
          throw new Error('Django error ' + response.statusCode);
        }
      }
    );
  })
  .done();
});

jobs.process('hq_upload', 4, function(job, done) {
  var uuid = job.data.uuid;
  var up_token = job.data.up_token;
  var recording_directory = directory_for_uuid(uuid);
  var hq_source_path = recording_directory + '/hq/hq.mp4';
  var hq_s3_location = '';
  var hq_s3_path = uuid + '/hq.mp4';
  var public_header = { 'x-amz-acl': 'public-read' };

  s3_upload({
              client: client,
              s3_path: hq_s3_path,
              file_path: hq_source_path,
              acl_header: public_header
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
        job.log(body);
        if(response === undefined){
          job.log("Could not reach endpoint");
          throw new Error('Could not reach Django');
        } else if(response.statusCode == 200){
          job.log("Result!");
          done();
        } else {
          job.log('Error: ' + response.statusCode);
          throw new Error('Django error ' + response.statusCode);
        }
      }
    );
  }, function(err){
    console.log('S3 error:');
    console.log(err);
    job.log('Error: ' + err);
    throw err;
  })
  .done();
});

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

function start_concatenate_job(uuid, up_token) {
  var job = jobs.create('concatenate', {
        title: uuid,
        uuid: uuid
    }).save();

  job.on('complete', function(){
    start_convert_job(uuid, up_token);
  }).on('failed', function(){
    console.log("Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_convert_job(uuid, up_token) {
  var convert_job = jobs.create('convert', {
      title: uuid,
      uuid: uuid
  }).save();
  convert_job.on('complete', function(){
    console.log("convert job complete");
    start_thumbnail_job(uuid, up_token);
  }).on('failed', function(){
    console.log("convert Job failed");
  }).on('progress', function(progress){
    //console.log('\r  convert job #' + convert_job.id + ' ' + progress + '% complete');
  });
}

function start_thumbnail_job(uuid, up_token) {
  var job = jobs.create('thumbnail', {
        title: uuid,
        uuid: uuid
    }).save();

  job.on('complete', function(){
    console.log("Thumbnailing complete.");
    start_upload_lq_to_s3_job(uuid, up_token);
  }).on('failed', function(){
    console.log("thumbnailing Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_upload_lq_to_s3_job(uuid, up_token) {
  var job = jobs.create('lq_upload', {
        title: uuid,
        uuid: uuid,
        up_token: up_token
    }).save();

  job.on('complete', function(){
    console.log("Upload lq complete.");
  }).on('failed', function(){
    console.log("Upload lq Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_upload_hq_to_s3_job(uuid, up_token) {
  var job = jobs.create('hq_upload', {
        title: uuid,
        uuid: uuid,
        up_token: up_token
    }).save();

  job.on('complete', function(){
    console.log("Upload lq complete.");
  }).on('failed', function(){
    console.log("Upload lq Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_upload_to_failed_bucket_job(uuid, up_token) {
  var job = jobs.create('failed_upload', {
        title: uuid,
        uuid: uuid,
        up_token: up_token
    }).save();

  job.on('complete', function(){
    console.log("Upload conflict complete.");
  }).on('failed', function(){
    console.log("Upload conflict Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function directory_for_uuid(uid) {
  return glob_path_prefix + uid;
}

function s3_upload(s3_upload_params){
    var deferred = Q.defer();
    console.log('s3 upload params:');
    console.log(s3_upload_params);
    var upload = new MultiPartUpload(
      {
          client: s3_upload_params.client,
          objectName: s3_upload_params.s3_path,
          file: s3_upload_params.file_path,
          headers: s3_upload_params.acl_header
      }, function(err, res){}
    );

    upload.on('completed', function(body){
      console.log('s3 mpu completed');
      console.log(body);
      deferred.resolve(body);
    });

    upload.on('failed', function(result){
      console.log('s3 mpu failed on ' + s3_upload_params.file_path);
      //console.log(result);
      deferred.reject(new Error('s3 mpu failed'));
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

/* Utility functions */

// Returns a promise which is fulfilled with 'true', 'false'
// on success
// requires knox, q
function s3_exists(filepath){
    var deferred = Q.defer();
    try{
        client.head(filepath).on('response', function(res){
        //console.log(filepath + ' response statusCode: ' + res.statusCode);
        if(res.statusCode === 404){
            deferred.resolve(false);
        } else{
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