add_executable(wildpaw-room
  src/main.cpp
  src/input_buffer.cpp
  src/room_simulation.cpp
  src/room_session.cpp
  src/snapshot_builder.cpp
  src/interest_manager.cpp
  src/wire_json.cpp
  src/wire_binary.cpp
)

target_include_directories(wildpaw-room
  PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/../shared
)

find_package(Boost REQUIRED COMPONENTS system)

target_link_libraries(wildpaw-room
  PRIVATE
    Boost::system
    pthread
)
