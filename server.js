var kue = require('kue'),
express = require('express'),
ffmpeg = require('fluent-ffmpeg'),
glob = require('glob'),
fs = require('fs'),
exec = require('child_process').exec,
app = express.createServer(),
jobs = kue.createQueue(); // create our job queue

app.listen(3000);
app.use(kue.app);
console.log('UI started on port 3000');
var glob_path_prefix = "/internment/";

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
                done();
              } else {
                done();
              }
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
  .takeScreenshots(1, recording_directory, function(err, filenames) {
    job.log('screenshots were saved');
    done();
  });
});

app.get('/process/:uuid', function (req, res) {
  var uuid = req.params.uuid;
  console.log('starting ' + uuid);
  res.send('Starting job...');
  start_concatenate_job(uuid);
});

function start_concatenate_job(uuid) {
  var job = jobs.create('concatenate', {
        title: uuid,
        uuid: uuid
    }).save();

  job.on('complete', function(){
    start_convert_job(uuid);
  }).on('failed', function(){
    console.log("Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
}

function start_convert_job(uuid) {
  var convert_job = jobs.create('convert', {
      title: uuid,
      uuid: uuid
  }).save();
  convert_job.on('complete', function(){
    start_thumbnail_job(uuid);
  }).on('failed', function(){
    console.log("convert Job failed");
  }).on('progress', function(progress){
    //console.log('\r  convert job #' + convert_job.id + ' ' + progress + '% complete');
  });
}

function start_thumbnail_job(uuid) {
  var job = jobs.create('thumbnail', {
        title: uuid,
        uuid: uuid
    }).save();

  job.on('complete', function(){
    console.log("Thumbnailing complete.");
    // 3: Tell the web server we've stopped processing!
    /*callEndpoint('end_processing',{
      public_upload_token: up_token,
      recording_id: uid,
      recording_type: 'video',
      error_message: error,
      path: config.bucketDomain + '/public/uploads/' + uid + '/full.mp4',
      thumb: config.bucketDomain + '/public/uploads/' + uid + '/thumb.png'
    });*/
  }).on('failed', function(){
    console.log("thumbnailing Job failed");
  }).on('progress', function(progress){
    //console.log('\r  concat job #' + job.id + ' ' + progress + '% complete');
  });
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