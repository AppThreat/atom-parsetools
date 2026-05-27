$env:GEM_HOME="."
bundle install --binstubs=../bin --no-cache --standalone=frontend
Remove-Item -Recurse -Force bundle\ruby\3.4.0\bundler\gems\ruby_ast_gen-*\.git* -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force bundle\ruby\3.4.0\cache -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force bundle\ruby\4.0.0\bundler\gems\ruby_ast_gen-*\.git* -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force bundle\ruby\4.0.0\cache -ErrorAction SilentlyContinue

# Clean up Ruby gems bloat - docs and tests
Get-ChildItem -Path "bundle\ruby\*\gems" -Recurse -Include "test","tests","spec","doc","docs","example","examples" -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "bundle\ruby\*\gems" -Recurse -Include "*.md","*.txt","*.gemspec","Rakefile","*.yml","*.yaml" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

# Clean up documentation in extensions and bundler
Get-ChildItem -Path "bundle\ruby\*\extensions" -Recurse -Include "*.md","*.txt" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "bundle\ruby\*\bundler" -Recurse -Include "*.md","*.txt" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

