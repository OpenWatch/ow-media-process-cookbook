name             'ow_media_process'
maintainer       'OpenWatch FPC'
maintainer_email 'contact@openwatch.net'
license          'All rights reserved'
description      'Installs/Configures ow_media_process'
long_description IO.read(File.join(File.dirname(__FILE__), 'README.md'))
version          '0.1.0'

recipe "ow_media_process", "runs NodeMediaProcess application"
recipe "ow_media_process::sync", "updates NodeMediaProcess application code"

depends "nginx"
depends "git_ssh_wrapper"
depends "user", "~> 0.3.0"
depends "npm"
depends "ow_media_capture"
