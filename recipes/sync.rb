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

# Checkout and Deploy NodeMediaProcess application
# See Chef's deploy resource docs: 
# http://wiki.opscode.com/display/chef/Deploy+Resource
deploy_revision app_root do
  repository node['ow_media_process']['git_url']
  revision node['ow_media_process']['git_rev'] # or "<SHA hash>" or "HEAD" or "TAG_for_1.0" or (subversion) "1234"
  user node['ow_media_process']['git_user']
  group node['ow_media_process']['service_user_group']
  enable_submodules true
  migrate false
  shallow_clone true
  action :deploy # or :rollback
  git_ssh_wrapper node['ow_media_process']['git_ssh_wrapper']
  scm_provider Chef::Provider::Git # is the default, for svn: Chef::Provider::Subversion

  # notifies :restart, "service["+ node['ow_media_process']['service_name'] +"]"

end

# create default.yaml
secrets = Chef::EncryptedDataBagItem.load(node['ow_media_process']['secret_databag_name'], node['ow_media_process']['secret_item_name'])

template app_root + '/current' + node['ow_media_process']['config_path'] do
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
    path app_root + '/current'
    action :install_from_json
end

npm_package "forever" do
    version "0.10.0"
    path app_root + '/current'
    action :install_local
  end

# Set permissions on node_modules dir
directory app_root + '/current/node_modules' do
  owner node['ow_media_process']['service_user'] 
  group node['ow_media_process']['service_user_group']
  mode "770"
  recursive true
  action :create
end

# Set permissions on config dir
directory app_root + '/current/config' do
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
