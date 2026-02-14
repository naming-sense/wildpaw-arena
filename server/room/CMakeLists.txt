add_executable(wildpaw-room
  src/main.cpp
  src/input_buffer.cpp
  src/room_simulation.cpp
  src/room_session.cpp
  src/snapshot_builder.cpp
  src/interest_manager.cpp
)

target_include_directories(wildpaw-room
  PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/../shared
)

find_package(asio CONFIG QUIET)
if(asio_FOUND)
  target_link_libraries(wildpaw-room PRIVATE asio::asio)
else()
  message(WARNING "asio package not found via CMake config. Install standalone Asio or provide include paths manually.")
endif()
