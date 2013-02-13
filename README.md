NodeMediaProcess
================

Video processing server/queue for Node.js

Dependencies
------------

1. Install ffmpeg
2. Make sure to install express@2.5.11 because the new one doesn't work.
3. All the other stuff in `npm-shrinkwrap.json`.

Configuration
------------

1. Rename `config/default-template.yaml` to `config/default.yaml` and change the values according to your desired configuration.


Job Types
------------

* concatenate
	* globs *.mp4, converts to .ts, cats them together into full.ts
* convert
	* converts full.ts to full.mp4
* thumbnail
	* generates thumb.jpg from full.mp4
* lq_upload
	* uploads thumb.jpg and full.mp4 to S3 bucket
* hq_upload
	* uploads hq.mp4 to S3 bucket 

API Endpoints
------------

* `POST /process_lq/:up_token/:uuid`
	* Starts concatenate => convert => thumbnail => lq_upload jobs
* `POST /process_hq/:up_token/:uuid`
	* Starts hq_upload job