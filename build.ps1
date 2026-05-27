php --php-ini php.ini -r "copy('http://getcomposer.org/installer', 'composer-setup.php');"
php -r "if (hash_file('sha384', 'composer-setup.php') === 'e21205b207c3ff031906575712edab6f13eb0b361f2085f1f1237b7126d785e826a450292b6cfd1d64d92e6563bbde02') { echo 'Installer verified'; } else { echo 'Installer corrupt'; unlink('composer-setup.php'); } echo PHP_EOL;"
php --php-ini php.ini composer-setup.php
php -r "unlink('composer-setup.php');"
$env:COMPOSER_VENDOR_DIR="plugins"
php --php-ini php.ini composer.phar require nikic/php-parser:4.18.0 --ignore-platform-reqs --optimize-autoloader

# Clean up unnecessary files from PHP parser
Get-ChildItem -Path "plugins/nikic" -Recurse -Include "*.md","*.yml","*.yaml" -File | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "plugins/nikic" -Recurse -Include "test","tests","spec","doc","docs" -Directory | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "plugins/nikic" -Recurse -Directory -Filter ".git*" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

cd plugins\rubyastgen
.\setup.ps1
cd ..\..

Remove-Item -Force plugins\bin\racc.cmd plugins\bin\ruby-parse.cmd plugins\bin\ruby-rewrite.cmd

# Clean up Ruby bundle bloat - remove documentation, tests, and build artifacts
$rubyBundle = "plugins\rubyastgen\bundle\ruby"
Get-ChildItem -Path "$rubyBundle" -Recurse -Include "test","tests","spec","doc","docs" -Directory | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "$rubyBundle" -Recurse -Include "*.md","*.txt","*.yml","*.yaml","*.gemspec","Rakefile","Gemfile*" -File | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "$rubyBundle" -Recurse -Directory -Filter "build_info" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "$rubyBundle" -Recurse -Directory -Filter "cache" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "$rubyBundle" -Recurse -Directory -Filter ".git*" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$rubyBundle\.bundle" -ErrorAction SilentlyContinue

Remove-Item -Force composer.phar
Remove-Item -Force composer.json
Remove-Item -Force composer.lock
