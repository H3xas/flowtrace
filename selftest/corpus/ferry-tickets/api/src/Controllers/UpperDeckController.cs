using Ferry.Api.Routes;
using Ferry.Api.Services;

namespace Ferry.Api.Controllers;

[Route(ApiRoutes.Decks.Upper)]
public class UpperDeckController : ControllerBase
{
    private readonly SeatMap _seats;

    public UpperDeckController(SeatMap seats)
    {
        _seats = seats;
    }

    [HttpGet("seats")]
    public IActionResult Seats()
    {
        return Ok(_seats.Upper());
    }
}
