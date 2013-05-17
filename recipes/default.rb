#
# Cookbook Name:: ow_media_process
# Recipe:: default
#
# Copyright 2013, YOUR_COMPANY_NAME
#
# All rights reserved - Do Not Redistribute
#
#
# Cookbook Name:: ow_media_capture
# Recipe:: default
#
# Copyright 2013, The OpenWatch Corporation, FPC
#
# All rights reserved - Do Not Redistribute
#


# Upstart service config file
template "/etc/init/" + node['ow_media_process']['service_name'] + ".conf" do
    source "upstart.conf.erb"
    owner node['ow_media_process']['service_user'] 
    group node['ow_media_process']['service_user_gid'] 
    variables({
    :service_user => node['ow_media_process']['service_user'],
    :app_root => node['ow_media_process']['app_root'],
    :run_script => node['ow_media_process']['run_script'],
    :log_path => node['ow_media_process']['log_dir'] + node['ow_media_process']['app_log_file']
    })
end

# Make log dir
directory node['ow_media_process']['log_dir'] do
  owner node['nginx']['user']
  group node['ow_media_process']['service_user_gid']
  mode "770" 
  recursive true
  action :create
end

# Nginx config file
template node['nginx']['dir'] + "/sites-enabled/media_process.nginx" do
    source "media_process.nginx.erb"
    owner node['nginx']['user']
    group node['nginx']['group']
    variables({
    :http_listen_port => node['ow_media_process']['http_listen_port'],
    :app_domain => node['ow_media_process']['app_domain'],
    :https_listen_port => node['ow_media_process']['https_listen_port'],
    :ssl_cert => node['ow_media_process']['ssl_dir'] + node['ow_media_process']['ssl_cert'],
    :ssl_key => node['ow_media_process']['ssl_dir'] + node['ow_media_process']['ssl_key'],
    :app_root => node['ow_media_process']['app_root'],
    :access_log => node['ow_media_process']['log_dir'] + node['ow_media_process']['access_log'],
    :error_log => node['ow_media_process']['log_dir'] + node['ow_media_process']['error_log'],
    :proxy_pass => node['ow_media_process']['proxy_pass'],
    :proxy_pass_port => node['ow_media_process']['app_port']
    })
    notifies :restart, "service[nginx]"
    action :create
end

include_recipe "ow_media_process::sync"

