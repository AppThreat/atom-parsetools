#!/usr/bin/env bash
set -e
rm -rf plugins/bin plugins/rubyastgen/bundle/

if command -v php >/dev/null 2>&1; then
  php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"
  php composer-setup.php
  php -r "unlink('composer-setup.php');"
  export COMPOSER_VENDOR_DIR=plugins
  php composer.phar require nikic/php-parser:5.7.0 --ignore-platform-reqs --optimize-autoloader
  rm composer.phar
  mv composer.json composer.lock plugins/
  
  # Clean up unnecessary files from PHP parser
  find plugins/nikic -type f \( -name "*.md" -o -name "*.yml" -o -name "*.yaml" \) -delete
  find plugins/nikic -type d \( -name "test" -o -name "tests" -o -name "spec" -o -name "doc" -o -name "docs" -o -name ".git" \) -exec rm -rf {} + 2>/dev/null || true
else
  echo "PHP plugins not built."
fi

if command -v ruby >/dev/null 2>&1 && command -v bundle >/dev/null 2>&1; then
  cd plugins/rubyastgen
  bash setup.sh
  cd ../..
  rm plugins/bin/racc plugins/bin/ruby-parse plugins/bin/ruby-rewrite
  
  # Clean up Ruby bundle bloat - remove documentation, tests, and build artifacts
  RUBY_BUNDLE="plugins/rubyastgen/bundle/ruby"
  find "$RUBY_BUNDLE" -type d \( -name "test" -o -name "tests" -o -name "spec" -o -name "doc" -o -name "docs" \) -exec rm -rf {} + 2>/dev/null || true
  find "$RUBY_BUNDLE" -type f \( -name "*.md" -o -name "*.txt" -o -name "*.yml" -o -name "*.yaml" -o -name "*.gemspec" -o -name "Rakefile" -o -name "Gemfile*" \) -delete
  rm -rf "$RUBY_BUNDLE"/*/build_info
  rm -rf "$RUBY_BUNDLE"/*/cache
  rm -rf "$RUBY_BUNDLE"/.bundle 2>/dev/null || true
  find "$RUBY_BUNDLE" -type d -name ".git*" -exec rm -rf {} + 2>/dev/null || true
else
  echo "Ruby plugins not built."
fi
