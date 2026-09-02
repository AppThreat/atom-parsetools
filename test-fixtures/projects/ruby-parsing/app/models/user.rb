# frozen_string_literal: true

class User < ApplicationRecord
  has_many :posts, dependent: :destroy
  validates :email, presence: true

  ROLES = %i[admin editor viewer].freeze
  EMAIL = /\A[^@\s]+@[^@\s]+\z/i

  def display_name
    [first_name, last_name].compact.join(" ")
  end

  def self.active = where(active: true)
end
