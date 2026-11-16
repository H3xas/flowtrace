using Ferry.Api.Routes;
using Ferry.Api.Services;

namespace Ferry.Api.Controllers;

[Route(ApiRoutes.Decks.Car)]
public class CarDeckController : ControllerBase
{
    private readonly SeatMap _seats;

    public CarDeckController(SeatMap seats)
    {
        _seats = seats;
    }

    [HttpGet("seats")]
    public IActionResult Seats()
    {
        return Ok(_seats.Car());
    }
}
