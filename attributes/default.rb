#
# Cookbook Name:: ow_media_process
# Attributes:: default
#
# Copyright 2013, OpenWatch FPC
#
# Licensed under the AGPLv3
#

# Chef repo
default['ow_media_process']['secret_databag_name'] 		= "secrets"
default['ow_media_process']['secret_item_name'] 		= "ow_media_process"

# SSL
default['ow_media_process']['ssl_databag_name'] 		= "ssl"
default['ow_media_process']['ssl_databag_item_name'] 	= "ssl"

# System
default['ow_media_process']['app_root']      		= "/var/www/NodeMediaProcess"
default['ow_media_process']['config_path']       	= "/config/default.yaml"
default['ow_media_process']['git_user']      		= "git"
default['ow_media_process']['service_user']      	= "media-process"
default['ow_media_process']['service_user_group']   = "service_users"
default['ow_media_process']['service_user_gid']     = 500
default['ow_media_process']['service_name']      	= "ow_media_process"
default['ow_media_process']['git_url']      		= "git@github.com:OpenWatch/NodeMediaProcess.git"
default['ow_media_process']['git_rev']      		= "HEAD"
default['ow_media_process']['git_ssh_wrapper']   	= "/home/git/.ssh/wrappers/ow-github_deploy_wrapper.sh"
default['ow_media_process']['log_dir']     			= "/var/log/ow/"
default['ow_media_process']['app_log_file']		    = "ow_media_process.log"
default['ow_media_process']['run_script']	    	= "run.sh"

# Nginx
default['ow_media_process']['http_listen_port']     = 80
default['ow_media_process']['https_listen_port']    = 443
default['ow_media_process']['ssl_dir']				= "/srv/ssl/"
default['ow_media_process']['ssl_cert']     		= "star_openwatch_net.crt"
default['ow_media_process']['ssl_key']     			= "star_openwatch_net.key"
default['ow_media_process']['access_log']     		= "nginx_access_media_capture.log"
default['ow_media_process']['error_log']     		= "nginx_error_media_capture.log"
default['ow_media_process']['proxy_pass']     		= "http://localhost:5001" ##

# NodeMediaCapture
default['ow_media_process']['temp_bucket']			= "/internment"

# NodeMediaProcess
default['ow_media_process']['app_port']	    		= 5001
default['ow_media_process']['processed_subdir']	    = "/processed"
default['ow_media_process']['aws_bucket']	    	= "openwatch-capture"
default['ow_media_process']['aws_rejected_bucket']	= "openwatch-capture-rejected"
default['ow_media_process']['process_api_url']		= "localhost/api/"

# Django
default['ow_media_process']['django_api_schema']	= "https://"
default['ow_media_process']['django_api_url']		= "alpha.openwatch.net/api"
default['ow_media_process']['django_api_user']		= "test"