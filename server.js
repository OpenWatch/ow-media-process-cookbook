var kue = require('kue'),
express = require('express'),
ffmpeg = require('fluent-ffmpeg'),
glob = require('glob'),
fs = require('fs'),
exec = require('child_process').exec,
app = express.createServer(),
knox = require('knox'),
MultiPartUpload = require('knox-mpu'),
jobs = kue.createQueue(); // create our job queue

// AWS Settings
var aws_bucket = 'openwatch-capture';
var aws_key = process.env.AWS_KEY;
var aws_secret = process.env.AWS_SECRET;
// File's home
var glob_path_prefix = "/internment/";

// Knox S3 Client
var client = knox.createClient({
    key: aws_key,
    secret: aws_secret,
    bucket: aws_bucket
});

app.listen(5001);
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
      job.log('screenshots were saved');
      done();
  });
});

app.get('/process_lq/:up_token/:uuid', function (req, res) {
  var uuid = req.params.uuid;
  var up_token = req.params.up_token;
  console.log('starting lq ' + uuid);
  res.send('Starting lq job...');
  start_concatenate_job(uuid, up_token);
});

app.get('/process_hq/:up_token/:uuid', function (req, res) {
  var uuid = req.params.uuid;
  var up_token = req.params.up_token;
  console.log('starting hq ' + uuid);
  res.send('Starting hq job...');
  var recording_directory = directory_for_uuid(uuid);
  var source_path = recording_directory + '/hq/hq.mp4';
  //start_concatenate_job(uuid);
  var hq_upload = new MultiPartUpload(
          {
              client: client,
              objectName: uuid + '/hq.mp4', // Amazon S3 path
              file: source_path       // Local path
          },
          function(err, res) {
            console.log('HQ upload response:');
            console.log(res);
          // On Successful upload, res will look like:
          //{ Location: 'https://openwatch-capture.s3.amazonaws.com/ore%2Ftest.mp4',
    //  Bucket: 'openwatch-capture',
    //  Key: 'jewels/<uuid>/hq.mp4',
    //  ETag: '"745a409f6f05ef102a5409a3d306d030-1"',
    //  size: 5222664 }
          }
  );
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
    upload_lq_to_s3(uuid, up_token);
  }).on('failed', function(){
    console.log("thumbnailing Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function upload_lq_to_s3(uuid, up_token) {
  var recording_directory = directory_for_uuid(uuid);
  var lq_source_path = recording_directory + '/full.mp4';
  var thumb_source_path = recording_directory + '/thumb.jpg';
  var lq_s3_location = '';
  var thumb_s3_location = '';
  var lq_upload = new MultiPartUpload(
      {
          client: client,
          objectName: uuid + '/lq.mp4', // Amazon S3 path
          file: lq_source_path
      },
      function(err, res) {
        console.log('LQ upload response:');
        console.log(res);
        var response = JSON.parse(res);
        lq_s3_location = response['Location'];

        var thumb_upload = new MultiPartUpload(
            {
                client: client,
                objectName: uuid + '/thumb.jpg', // Amazon S3 path
                file: thumb_source_path
            },
            function(err, res) {
              console.log('LQ thumb response:');
              console.log(res);
              var response = JSON.parse(res);
              thumb_s3_location = response['Location'];
              console.log('lq: ' + lq_s3_location + "\nthumb: " + thumb_s3_location);
              /*
              callEndpoint('end_processing', {
                public_upload_token: up_token,
                recording_id: uuid,
                recording_type: 'video',
                error_message: error,
                path: lq_s3_location,
                thumb: thumb_s3_location
              });
              */
            }
        );
      }
  );


}

function directory_for_uuid(uid) {
  return glob_path_prefix + uid;
}

/*
*
*  API
*
*/

function callEndpoint(endpoint, params){

  console.log("Posting to..");
  console.log(makeEndpointUrl(endpoint));
  console.log('\n');

  request.post(
      makeEndpointUrl(endpoint),
      {
        form:params
      },

    function (error, response, body) {
        if(response === undefined){
          console.log("Could not reach endpoint");
          console.log(body);
        } else if(response.statusCode == 200){
          console.log("Result!");
          console.log(body);
        } else {
          console.log('Error: ' + response.statusCode);
          console.log(body);
        }
      }
  );
}

function makeEndpointUrl(endpoint){
  return config.api_schema + config.api_user + ':' + config.api_password + '@' + config.api_url + endpoint;
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