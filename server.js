var kue = require('kue'),
express = require('express'),
ffmpeg = require('fluent-ffmpeg'),
glob = require('glob'),
app = express.createServer(),
jobs = kue.createQueue(); // create our job queue

app.listen(3000);
app.use(kue.app);
console.log('UI started on port 3000');

jobs.process('concatenate', 4, function(job, done) {
  var uid = job.data.uuid;
  console.log('Starting ' + uid);
  job.log('Starting ' + uid);
  glob("/internment/" + uid + "/*.mp4", {nosort: false}, function (err, files) {
    files.sort(naturalSort);
    all_files = files;

    if(err){
      console.log("Error globbing!");
      job.log("Something went wrong!");
      job.log(err);
      stitch_fail(uid, err);
    }
    console.log("Found files: " + files.length);
    job.log("Found files: " + files.length);

    pieces = files.length;
    var out_file;
    var out_files = [];
    for ( var i = 0, l = files.length; i < l; i++) {
      var input_file = files[i];
      console.log("starting ffmpeg for: " + input_file);
      job.progress(i+1, files.length);
      out_file = input_file.replace('mp4', 'ts');
      var proc = new ffmpeg({ source: input_file, priority: 10 })
      .withVideoCodec('copy')
      .withAudioCodec('copy')
      .addOption('-vbsf', 'h264_mp4toannexb')
      .toFormat('mpegts')
      .saveToFile(out_file, function(stdout, stderr) {
        job.log('file has been converted succesfully');
      });
    }
    done();
  });
});

app.get('/process/:uid', function (req, res) {
  var uuid = req.params.uid;
  console.log('starting ' + uuid);
  var job = jobs.create('concatenate', {
        title: uuid,
        uuid: uuid
    }).save();
  res.send('yep');

  job.on('complete', function(){
    console.log("Job complete");
  }).on('failed', function(){
    console.log("Job failed");
  }).on('progress', function(progress){
    console.log('\r  job #' + job.id + ' ' + progress + '% complete');
  });
});


function generate_thumbnail(up_token, uid){
  var thumb_command = 'ffmpeg -i {0}/full.mp4 -an -ss 00:00:02 -an -r 1 -vframes 1 -y {0}/thumb.png; ffmpeg -i {0}/full.mp4 -an -ss 00:00:02 -an -r 1 -vframes 1 -y -s 300x300 {0}/thumb.png.300x300_q85_crop.jpg;'.format('public/uploads/' + uid);

  console.log("Thumb nailing..");
  console.log(thumb_command);

  exec(thumb_command, function (error, stdout, stderr) {
    console.log("thumbnail log: " + stderr);
    if (error !== null) {
      console.log('Thumb failed. What should we do?\n\n' + error);
    }else{
      console.log("Hooray, we have a thumbnail!");
    }

    // 3: Tell the web server we've stopped processing!
    callEndpoint('end_processing',{
      public_upload_token: up_token,
      recording_id: uid,
      recording_type: 'video',
      error_message: error,
      path: config.bucketDomain + '/public/uploads/' + uid + '/full.mp4',
      thumb: config.bucketDomain + '/public/uploads/' + uid + '/thumb.png'
    });

  });

}

function smoosh_files(up_token, uid){

  var all_files;
  var pieces_tsd = 0;
  var pieces = 0;

  function concatenate(){
    pieces_tsd++;
    if(pieces_tsd != pieces){
      return;
    }

    var out_file_concat = '';
    for(var i = 0, l = all_files.length; i < l; i++){
      out_file_concat += ' {0} '.format(all_files[i].replace('mp4', 'ts'));
    }

    var cat_command = 'cat {0} > {1}/full.ts'.format(out_file_concat, 'public/uploads/' + uid);
    exec(cat_command, function (error, stdout, stderr) {
        if (error !== null) {
          console.log('Cat failed. What should we do?\n\n' + error);
          return;
        }

        var stitch_command = 'ffmpeg -i {0}/full.ts -f mp4 -vcodec copy -acodec copy -absf aac_adtstoasc {0}/full.mp4'.format('public/uploads/' + uid);
        exec(stitch_command, function (error, stdout, stderr) {

          if (error !== null) {
            console.log('Stitch failed. What should we do?\n\n' + error);
          }else{
            console.log("Hooray, files are stitched!");
          }

          generate_thumbnail(up_token, uid);

        });
      });
  }

  
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