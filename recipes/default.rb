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
    :app_root => node['ow_media_process']['app_root'] + '/current',
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

include_recipe "ow_media_process::sync"

