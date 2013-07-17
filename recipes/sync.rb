include_recipe "python"

# Establish ssh wrapper for the git user

app_root = node['ow_media_process']['app_root']

ssh_key = Chef::EncryptedDataBagItem.load("ssh", "git")

# Get group name from gid cause this library is "different"
groups_databag_name = node['ow_users']['groups_databag_name']
groups_item_name = node['ow_users']['groups_databag_item_name']
gids_item = data_bag_item(groups_databag_name, groups_item_name)
gids = gids_item["gids"]

git_ssh_wrapper "ow-github" do
  owner node['ow_media_process']['git_user']
  group gids[node['ow_media_process']['service_user_gid'].to_s()]
  ssh_key_data ssh_key['id_rsa']
end

# Make git checkout dir
directory node['ow_media_process']['app_root'] do
  owner node['ow_media_process']['git_user']
  group node['ow_media_process']['service_user_group']
  recursive true
  action :create
end

# Git checkout
git node['ow_media_process']['app_root'] do
   repository node['ow_media_process']['git_url'] 
   revision node['ow_media_process']['git_rev']  
   ssh_wrapper "/home/" + node['ow_media_process']['git_user'] + "/.ssh/wrappers/ow-github_deploy_wrapper.sh"
   enable_submodules true
   action :sync
   user node['ow_media_process']['git_user']
   group node['ow_media_process']['service_user_group']
end

# Create /.git/config
template node['ow_media_process']['app_root'] + "/.git/config" do
    source "config.erb"
    owner node['ow_media_process']['git_user']
    group node['ow_media_process']['service_user_group']
    variables({
      :git_url => node['ow_media_process']['git_url']
    })
    action :create
end

# create default.yaml
secrets = Chef::EncryptedDataBagItem.load(node['ow_media_process']['secret_databag_name'], node['ow_media_process']['secret_item_name'])

template app_root + node['ow_media_process']['config_path'] do
    source "default.yaml.erb"
    user node['ow_media_process']['git_user']
    group node['ow_media_process']['service_user_group']
    mode "440"
    variables({
    :app_port => node['ow_media_process']['app_port'], 
    :processed_subdir => node['ow_media_process']['processed_subdir'],
    :aws_bucket => node['ow_media_process']['aws_bucket'],
    :aws_rejected_bucket => node['ow_media_process']['aws_rejected_bucket'],
    :aws_key => secrets['aws_key'],
    :aws_secret => secrets['aws_secret'],
    :capture_directory => node['ow_media_process']['temp_bucket'],
    :django_api_schema => node['ow_media_process']['django_api_schema'],
    :django_api_user => secrets['django_api_user'],
    :django_api_password => secrets['django_api_password'],
    :django_api_url => node['ow_media_process']['django_api_url'],
    :sentry_dsn => secrets['sentry_dsn'],
    :http_user => secrets['http_user'],
    :http_pw => secrets['http_pw']
    })
end

npm_package "package.json" do
    path app_root
    action :install_from_json
end

npm_package "forever" do
    version "0.10.0"
    path app_root
    action :install_local
  end

# Set permissions on node_modules dir
directory app_root + '/node_modules' do
  owner node['ow_media_process']['service_user'] 
  group node['ow_media_process']['service_user_group']
  mode "770"
  recursive true
  action :create
end

# Set permissions on config dir
directory app_root + '/config' do
  owner node['ow_media_process']['service_user'] 
  group node['ow_media_process']['service_user_group']
  mode "770"
  recursive true
  action :create
end

# Register capture app as a service
service node['ow_media_process']['service_name'] do
  provider Chef::Provider::Service::Upstart
  action [:stop, :start]
end
