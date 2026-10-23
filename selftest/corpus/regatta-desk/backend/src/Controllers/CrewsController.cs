using Microsoft.AspNetCore.Mvc;

namespace Regatta.Api.Controllers
{
    [ApiController]
    [Route("crews/v1")]
    public class CrewsController : ControllerBase
    {
        [HttpGet("{id}")]
        public IActionResult Get(string id)
        {
            return Ok();
        }

        [HttpPost("{id}/signup")]
        public IActionResult Signup(string id)
        {
            return Ok();
        }

        [HttpGet("signups")]
        public IActionResult Signups()
        {
            return Ok();
        }

        [HttpPost("{id}/release")]
        public IActionResult Release(string id)
        {
            return Ok();
        }
    }
}
